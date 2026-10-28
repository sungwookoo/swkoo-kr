(function(root){
  function checkZip(buffer){
    const view=new DataView(buffer),size=view.byteLength;
    const fail=()=>{throw Error('지원하지 않거나 손상된 XLSX 압축 파일입니다.');};
    if(size<22)fail();
    let end=-1;
    for(let i=size-22;i>=Math.max(0,size-65557);i--){
      if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===size){end=i;break;}
    }
    if(end<0||view.getUint16(end+4,true)||view.getUint16(end+6,true))fail();
    const entries=view.getUint16(end+10,true),length=view.getUint32(end+12,true),start=view.getUint32(end+16,true);
    if(!entries||entries>512||entries!==view.getUint16(end+8,true)||start+length!==end)fail();
    let at=start,total=0;
    for(let i=0;i<entries;i++){
      if(at+46>end||view.getUint32(at,true)!==0x02014b50)fail();
      const flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),compressed=view.getUint32(at+20,true),expanded=view.getUint32(at+24,true);
      const name=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true),local=view.getUint32(at+42,true);
      if(flags&1||![0,8].includes(method)||local+30>start||view.getUint32(local,true)!==0x04034b50)fail();
      const data=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
      if(data+compressed>start||view.getUint16(local+8,true)!==method||at+46+name+extra+comment>end)fail();
      total+=expanded;
      if(total>16*1024*1024||expanded>Math.max(1,compressed)*200)throw Error('압축 해제 크기 또는 압축률이 너무 큰 파일입니다. 작은 파일로 나눠주세요.');
      at+=46+name+extra+comment;
    }
    if(at!==end)fail();
  }
  const api={checkZip};if(typeof module!=='undefined')module.exports=api;else root.ExcelSafety=api;
})(typeof self==='undefined'?globalThis:self);
