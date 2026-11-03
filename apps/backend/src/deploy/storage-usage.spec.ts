import { storageUsage } from './storage-usage';

describe('storage counters must be fresh, valid and belong to the exact app Pod', () => {
  const now = Date.now();
  const row = { namespace:'user-alice',claimName:'app-data',claimUid:'pvc-uid',podUids:['pod-uid'],
    usedBytes:0,limitBytes:1024**3,usedInodes:1,limitInodes:65536 };
  const read = (volumes: unknown = [row], checkedAt = new Date(now).toISOString()) =>
    storageUsage(JSON.stringify({checkedAt,volumes}),'user-alice','app-data','pod-uid',now);
  it('returns real zero usage and remaining counts for a valid measurement', () => {
    expect(read()).toMatchObject({status:'ready',usedBytes:0,remainingBytes:1024**3,remainingInodes:65535,warning:null});
  });
  it('never substitutes zero for stale, future, missing or invalid measurements', () => {
    for (const result of [read([],new Date(now).toISOString()),read([row],new Date(now-90_001).toISOString()),
      read([row],new Date(now+5001).toISOString()),read([row],'bad'),read([row,row]),
      storageUsage('bad','user-alice','app-data','pod-uid',now)]) expect(result).toEqual({status:'unknown'});
    for (const patch of [{namespace:'user-bob'},{claimName:'other'},{podUids:['old-pod']},{usedBytes:-1},
      {usedBytes:Infinity},{usedBytes:1.1},{limitBytes:0},{limitInodes:1}]) expect(read([{...row,...patch}])).toEqual({status:'unknown'});
  });
  it('warns for either bytes or inode pressure and clamps remaining values at zero', () => {
    expect(read([{...row,usedBytes:Math.ceil(.8*1024**3)}])).toMatchObject({warning:'near_limit'});
    expect(read([{...row,usedInodes:52429}])).toMatchObject({warning:'near_limit'});
    expect(read([{...row,usedBytes:1024**3+4096,usedInodes:65536}])).toMatchObject({warning:'full',remainingBytes:0,remainingInodes:0});
  });
});
