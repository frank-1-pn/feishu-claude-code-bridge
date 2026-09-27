// Repair only unambiguous, outer-pipe Markdown tables whose rows were separated
// by blank paragraphs. The original answer/hash and attachments stay untouched.
// Leave fenced/indented code, quoted examples and complex pipe syntax alone.
export function normalizeCloudMarkdown(source) {
  const eol=source.includes('\r\n')?'\r\n':'\n', lines=source.split(/\r?\n/), out=[];
  const columns=line=> {
    if (!/^ {0,3}\|.*\|[ \t]*$/.test(line) || /[`\\]/.test(line)) return 0;
    return line.trim().split('|').length-2;
  };
  const nonblank=start=>{while(start<lines.length && !lines[start].trim())start++;return start;};
  let fence=null;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i],mark=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if(fence) {
      out.push(line);
      if(mark && mark[1][0]===fence.char && mark[1].length>=fence.length && !mark[2].trim())fence=null;
      continue;
    }
    if(mark) {fence={char:mark[1][0],length:mark[1].length};out.push(line);continue;}
    const count=columns(line), separator=nonblank(i+1);
    if(count<2 || columns(lines[separator]??'')!==count
      || !/^\|(?:\s*:?-{3,}:?\s*\|){2,}$/.test((lines[separator]??'').trim())) {out.push(line);continue;}
    const first=nonblank(separator+1);
    if(columns(lines[first]??'')!==count) {out.push(line);continue;}
    out.push(line,lines[separator]);let end=separator;
    while(true) {
      const next=nonblank(end+1);
      if(columns(lines[next]??'')!==count)break;
      out.push(lines[next]);end=next;
    }
    i=end;
  }
  return out.join(eol);
}
