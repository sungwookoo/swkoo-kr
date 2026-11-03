"""Destructive-retention boundaries. No live cloud calls or credentials."""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
from types import SimpleNamespace as Row
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('maintenance', ROOT/'scripts/ops/oci-storage-maintenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime(2026, 11, 3, 8, tzinfo=timezone.utc)


def image(n, version=None, days=10, **extra):
    return Row(id=f'id{n}', digest=f'sha256:{n:064x}', version=version,
               time_created=NOW-timedelta(days=days), lifecycle_state='AVAILABLE', **extra)


def manifest(*children):
    return {'schemaVersion': 2, 'manifests': [{'digest': c.digest} for c in children]}


def backup(days, name=None):
    date = (NOW-timedelta(days=days)).date()
    return Row(name=name or f'daily/{date}/observatory.sqlite',
               time_modified=NOW-timedelta(days=days), size=100, etag=str(days))


class RetentionSafety(unittest.TestCase):
    def test_protects_recursive_multiarch_and_shared_children(self):
        root, child, shared, obsolete = [image(i) for i in range(1, 5)]
        manifests = {root.digest: manifest(child), child.digest: manifest(shared), shared.digest: manifest()}
        keep, delete, _ = m.image_plan([root, child, shared, obsolete], {root.digest}, manifests.get, NOW)
        self.assertEqual(keep, set(manifests))
        self.assertEqual([i.id for i in delete], [obsolete.id])

    def test_protects_latest_unknown_storage_and_two_day_publish_grace(self):
        rows = [image(1, 'latest'), image(2, 'custom-release'),
                image(3, 'storage-helper-'+'a'*40), image(4, 'storage-provisioner-'+'b'*40),
                image(5, days=1), image(6)]
        keep, delete, _ = m.image_plan(rows, {rows[0].digest}, lambda _: manifest(), NOW)
        self.assertEqual({i.id for i in delete}, {'id6'})
        self.assertEqual(len(keep), 5)

    def test_preserves_three_recent_sha_roots_and_all_required_rollbacks(self):
        rows = [image(i, f'{i:040x}', days=i+3) for i in range(1, 7)]
        keep, delete, _ = m.image_plan(rows, {rows[-1].version}, lambda _: manifest(), NOW)
        self.assertEqual({i.id for i in delete}, {'id4', 'id5'})
        self.assertIn(rows[-1].digest, keep)

    def test_duplicate_versions_never_delete_same_image_twice(self):
        root, obsolete = image(1, 'latest'), image(2)
        alias = image(2)
        _, delete, _ = m.image_plan([root, obsolete, alias], {'latest'}, lambda _: manifest(), NOW)
        self.assertEqual([i.id for i in delete], ['id2'])

    def test_missing_required_or_child_and_invalid_manifest_fail_closed(self):
        root, child = image(1, 'latest'), image(2)
        for rows, refs, fetch in [([root], {'missing'}, lambda _: manifest()),
                                  ([root], {'latest'}, lambda _: manifest(child)),
                                  ([root], {'latest'}, lambda _: None),
                                  ([root], {'latest'}, lambda _: {})]:
            with self.subTest(refs=refs):
                with self.assertRaises(RuntimeError):
                    m.image_plan(rows, refs, fetch, NOW)

    def test_deleted_images_are_never_candidates(self):
        root, gone = image(1, 'latest'), image(2)
        gone.lifecycle_state = 'DELETED'
        _, delete, _ = m.image_plan([root, gone], {'latest'}, lambda _: manifest(), NOW)
        self.assertEqual(delete, [])

    def test_new_version_during_cleanup_stops_delete_and_uses_conditional_request(self):
        old = image(1, 'a'*40)
        client = Mock()
        client.get_container_image.return_value = Row(data=Row(versions=[Row(version='latest')]), headers={'etag': 'v1'})
        with self.assertRaises(RuntimeError):
            m.delete_image(client, old, [old])
        client.delete_container_image.assert_not_called()
        client.get_container_image.return_value.data.versions = [Row(version=old.version)]
        m.delete_image(client, old, [old])
        client.delete_container_image.assert_called_once_with(old.id, if_match='v1')

    def test_object_pagination_never_omits_second_page(self):
        client = Mock()
        client.list_objects.side_effect = [Row(data=Row(objects=[backup(1)], next_start_with='next')),
                                           Row(data=Row(objects=[backup(30)], next_start_with=None))]
        self.assertEqual(len(m.list_objects(client, 'namespace')), 2)
        self.assertEqual(client.list_objects.call_args.kwargs['start'], 'next')

    def test_backup_cutoff_and_only_exact_platform_database_keys(self):
        rows = [backup(i) for i in range(17)]
        foreign = [backup(90, 'user/alice/database.sqlite'), backup(90, 'daily/old/other.db')]
        owned, delete = m.backup_plan(rows+foreign, NOW)
        self.assertEqual(len(owned), 17)
        self.assertEqual({o.name for o in delete}, {rows[15].name, rows[16].name})

    def test_stale_or_missing_backup_never_deletes_anything(self):
        for rows in [[], [backup(3), backup(30)]]:
            with self.assertRaises(RuntimeError):
                m.backup_plan(rows, NOW)

    def test_keeps_minimum_two_recovery_points(self):
        fresh, old, older = backup(0), backup(30), backup(60)
        _, delete = m.backup_plan([old, older, fresh], NOW)
        self.assertEqual(delete, [older])

    def test_inventory_includes_rollback_init_and_digest_references(self):
        prefix = 'nrt.ocir.io/test/swkoo/'
        items = [{'kind': 'Deployment', 'metadata': {'name': 'swkoo-'+name, 'namespace': 'swkoo'},
                  'spec': {'template': {'spec': {'containers': [{'image': prefix+name+':active'}]}}}}
                 for name in ['backend', 'frontend']]
        items += [{'kind': 'ReplicaSet', 'metadata': {}, 'spec': {'template': {'spec': {
            'containers': [{'image': prefix+'backend:rollback'}],
            'initContainers': [{'image': prefix+'frontend@sha256:abc'}]}}}}]
        refs = m.references({'items': items}, 'test')
        self.assertEqual(refs['swkoo/backend'], {'active', 'rollback'})
        self.assertEqual(refs['swkoo/frontend'], {'active', 'sha256:abc'})
        with self.assertRaises(RuntimeError):
            m.references({'items': []}, 'test')


if __name__ == '__main__':
    unittest.main()
