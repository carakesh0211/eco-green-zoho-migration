// el() in the browser app (src/server/public/app.js) must accept numbers and server values
// wrapped as { value, untrusted } as children: the bulk-mapping result table passes the sheet
// row number, and appendChild() of a non-node threw "parameter 1 is not of type 'Node'".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/server/public/app.js', import.meta.url), 'utf8');
function pick(name) {
  const i = src.indexOf(`function ${name}(`);
  let j = src.indexOf(') {', i) + 2;
  for (let d = 0; j < src.length; j += 1) {
    if (src[j] === '{') d += 1;
    else if (src[j] === '}' && --d === 0) break;
  }
  return src.slice(i, j + 1);
}

class Node {
  constructor(text = '') { this.children = []; this.text = text; }
  appendChild(c) {
    if (!(c instanceof Node)) throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
    this.children.push(c);
    return c;
  }
  setAttribute() {}
  addEventListener() {}
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.text = String(v); }
}
const document = { createElement: () => new Node(), createTextNode: (t) => new Node(t) };

test('el() renders numbers and { value, untrusted } children as text', () => {
  const ctx = vm.createContext({ Node, document });
  vm.runInContext(`${pick('textOf')}\n${pick('el')}\nthis.el = el;`, ctx);
  const td = ctx.el('td', {}, [2, ' ', { value: 'Chq Recd', untrusted: true }, ' ', true, null, 'x']);
  assert.equal(td.textContent, '2 Chq Recd truex');
  const inner = ctx.el('span', {}, 'y');
  assert.equal(ctx.el('div', {}, inner).children[0], inner);
});
