const fs=require('fs');
const lines=fs.readFileSync('renderer.js','utf8').split(/\r?\n/);
for (let i=0;i<lines.length;i++){
  if (/icon: '/.test(lines[i]) || /parts A/.test(lines[i]) || /Creating/.test(lines[i]) || /Starting the studio engine/.test(lines[i])) {
    const s=lines[i];
    console.log(i+1, JSON.stringify(s), [...s].filter(c=>c.codePointAt(0)>126).map(c=>'U+'+c.codePointAt(0).toString(16)).join(' '));
  }
}
