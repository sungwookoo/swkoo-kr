importScripts('/excel-service/xlsx-safety.js','/excel-service/vendor/xlsx.full.min.js');
self.onmessage=({data})=>{
  try{
    ExcelSafety.checkZip(data);
    const workbook=XLSX.read(data,{type:'array',cellDates:true,sheetRows:5002});
    const sheet=workbook.Sheets[workbook.SheetNames[0]];
    if(!sheet||!sheet['!ref'])throw Error('데이터가 없습니다.');
    const range=XLSX.utils.decode_range(sheet['!ref']);
    if(range.e.c>5)throw Error('추가 열은 지원하지 않습니다.');
    if(Object.keys(sheet).some(k=>!k.startsWith('!')&&sheet[k].f))throw Error('수식 셀은 지원하지 않습니다. 값으로 붙여넣은 파일을 사용해주세요.');
    self.postMessage({rows:XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:true,blankrows:true})});
  }catch(error){self.postMessage({error:error.message});}
};
