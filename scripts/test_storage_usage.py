import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

spec=importlib.util.spec_from_file_location('usage',Path(__file__).resolve().parent.parent/'deploy/host/storage-usage.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class StorageUsageSafety(unittest.TestCase):
    def volume(self,namespace='user-alice',path=None):
        return {'metadata':{'name':'pvc-id'},'status':{'phase':'Bound'},'spec':{'claimRef':{'namespace':namespace,'name':'data','uid':'claim-id'},
            'local':{'path':path or f'/var/lib/rancher/k3s/storage/pvc-id_{namespace}_data'}}}
    def test_only_reads_direct_bound_user_volumes_and_skips_failed_measurements(self):
        reader=Mock(return_value={'usedBytes':4096})
        failed=self.volume(); failed['status']['phase']='Released'
        rows=m.collect([self.volume(),self.volume('swkoo'),self.volume(path='/etc/shadow'),failed],[],reader)
        self.assertEqual(len(rows),1);self.assertEqual(reader.call_count,1)
        reader.side_effect=OSError('quota inactive')
        self.assertEqual(m.collect([self.volume()],[],reader),[])
    def test_only_matches_current_pods_from_the_same_namespace_and_claim(self):
        def pod(uid,ns='user-alice',claim='data',**metadata):
            return {'metadata':{'uid':uid,'namespace':ns,**metadata},'spec':{'volumes':[{'persistentVolumeClaim':{'claimName':claim}}]}}
        pods=[pod('current'),pod('other','user-bob'),pod('different',claim='other'),pod('terminating',deletionTimestamp='now')]
        row=m.collect([self.volume()],pods,lambda _:{'usedBytes':1234})[0]
        self.assertEqual(row['podUids'],['current']);self.assertEqual(row['claimUid'],'claim-id')
        self.assertNotIn('path',row)

if __name__=='__main__':unittest.main()
