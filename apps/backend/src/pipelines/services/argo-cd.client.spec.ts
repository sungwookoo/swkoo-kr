import { of, throwError } from 'rxjs';
import { ArgoCdClient } from './argo-cd.client';

describe('project-scoped Argo application lookup', () => {
  function setup(status?: number) {
    const get=jest.fn(()=>status ? throwError(()=>({isAxiosError:true,response:{status},message:'lookup failed'})) : of({data:{metadata:{name:'swkoo-user-alice'}}}));
    const client=new ArgoCdClient({get} as any,{baseUrl:'http://argo',authToken:'Bearer fixture',projects:[]} as any);
    return {client,get};
  }
  it('sends the known ApplicationSet project to distinguish absent applications', async()=>{
    const s=setup(); await s.client.getApplication('swkoo-user-alice','default');
    expect(s.get).toHaveBeenCalledWith('http://argo/api/v1/applications/swkoo-user-alice',expect.objectContaining({params:{project:'default'}}));
  });
  it('returns null only for a real 404', async()=>{
    expect(await setup(404).client.getApplication('swkoo-user-alice','default')).toBeNull();
  });
  it('does not treat a permission or transport failure as no existing deployment', async()=>{
    await expect(setup(403).client.getApplication('swkoo-user-alice','default')).rejects.toThrow();
    await expect(setup(503).client.getApplication('swkoo-user-alice','default')).rejects.toThrow();
  });
});
