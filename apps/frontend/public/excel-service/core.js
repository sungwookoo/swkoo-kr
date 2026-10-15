(function(root){
const headers=['주문번호','거래처','주문일','수량','단가','금액'];
const samples=[
 {name:'가온상사.xlsx',rows:[['A-1001','가온상사','2026-10-01',10,2500,25000],['A-1002','가온상사','2026-10-02',4,12000,48000],['A-1003','','2026-10-03',3,5000,15000],['A-1004','가온상사','2026-02-30',2,8000,16000]]},
 {name:'누리유통.xlsx',rows:[['B-2001','누리유통','2026-10-01',6,3000,18000],['A-1002','누리유통','2026-10-02',4,12000,48000],['B-2003','누리유통','2026-10-03',-2,6000,-12000],['B-2004','누리유통','2026-10-04',5,2000,12000]]},
 {name:'다온기획.xlsx',rows:[['C-3001','다온기획','2026-10-01',8,4000,32000],['C-3002','다온기획','2026-10-02',3,7000,21000],['C-3003','다온기획','2026-10-03',2,15000,30000],['C-3004','다온기획','2026-10-04',10,1000,10000]]}
];
function validDate(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(v+'T00:00:00Z');return !isNaN(d)&&d.toISOString().slice(0,10)===v;}
function validate(files){
 let records=[];files.forEach(f=>f.rows.forEach((r,i)=>{if(r.every(v=>v===''||v==null))return;records.push({file:f.name,row:i+2,values:r.slice(0,6),errors:[]});}));
 const counts=new Map();records.forEach(r=>{const id=String(r.values[0]??'').trim();if(id)counts.set(id,(counts.get(id)||0)+1);});
 records.forEach(r=>{const v=r.values;headers.forEach((h,i)=>{if(v[i]==null||String(v[i]).trim()==='')r.errors.push(h+' 누락');});
 if(counts.get(String(v[0]??'').trim())>1)r.errors.push('주문번호 중복 (중복된 모든 행 확인)');
 if(v[2]!=null&&v[2]!==''&&!validDate(v[2]))r.errors.push('주문일 형식·날짜 오류');
 [3,4,5].forEach(i=>{if(v[i]==null||String(v[i]).trim()==='')return;const n=Number(v[i]);if(!Number.isFinite(n))r.errors.push(headers[i]+' 숫자 오류');else if(n<0)r.errors.push(headers[i]+' 음수');else if(!Number.isSafeInteger(n))r.errors.push(headers[i]+'는 정수만 지원');});
 if([3,4,5].every(i=>v[i]!==''&&v[i]!=null&&Number.isSafeInteger(Number(v[i])))&&Number(v[3])*Number(v[4])!==Number(v[5]))r.errors.push('금액 불일치: 수량 × 단가 = '+(Number(v[3])*Number(v[4])).toLocaleString('ko-KR')+'원');
 });return records;
}
const api={headers,samples,validate,validDate};if(typeof module!=='undefined')module.exports=api;else root.ExcelDemo=api;
})(typeof window==='undefined'?globalThis:window);
