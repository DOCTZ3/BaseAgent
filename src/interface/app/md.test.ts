// ============================================
// Markdown 渲染 —— 安全性与结构正确性
// ============================================
//
// 为什么值得有正式测试(而不是一次性探针):渲染的是**不可信文本** ——
// 模型输出、以及它从网页抓回来的片段。这里的错误分两类,都不会报错:
//   ① 安全:`javascript:` 链接被渲染成可点的 <a>、原始 HTML 被当标签解析
//   ② 结构:未闭合的代码围栏(流式中途必然出现)让整段回答消失
//
// 用最小 DOM 桩而不引 jsdom:md.js 只用到 createElement / createTextNode /
// createDocumentFragment / appendChild / textContent 这几个,
// 为它引一个几 MB 的依赖不划算。
// ============================================

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

interface StubNode {
  tagName: string;
  children: StubNode[];
  dataset: Record<string, string>;
  className: string;
  href?: string;
  textContent: string;
  appendChild(c: StubNode): StubNode;
  append(...cs: StubNode[]): void;
}

// 用闭包变量而不是 this:对象字面量里的 this 会被 TS 推断成 {},
// 于是 this.children 报 TS2339。闭包引用没有这个问题,也不需要 as unknown 断言
function mkNode(tag: string): StubNode {
  let text = '';
  const node: StubNode = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    className: '',
    // textContent 的语义照抄真实 DOM:设置它会清掉所有子节点,
    // 读取它会把子树的文本拼起来 —— md.js 依赖这两条
    get textContent(): string {
      return node.children.length === 0
        ? text
        : node.children.map(c => c.textContent).join('');
    },
    set textContent(v: string) {
      text = String(v);
      node.children = [];
    },
    appendChild(c: StubNode) { node.children.push(c); return c; },
    append(...cs: StubNode[]) { node.children.push(...cs); },
  };
  return node;
}

let md: {
  render(text: unknown): StubNode;
  into(node: StubNode, text: unknown): StubNode;
};

beforeAll(() => {
  (globalThis as any).document = {
    createElement: mkNode,
    createTextNode: (t: string) => ({
      tagName: '#text', children: [], textContent: String(t),
    }),
    createDocumentFragment: () => mkNode('#fragment'),
  };
  const holder: any = {};
  (globalThis as any).window = holder;

  // md.js 是 IIFE,靠副作用挂到 window 上 —— 用 eval 加载,
  // 因为它不是模块(客户端要能在 file:// 下直接 <script> 引入)
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/interface/app/md.js'), 'utf8',
  );
  // eslint-disable-next-line no-eval
  eval(src);
  md = holder.AgentMarkdown;
});

/** 收集渲染树里出现的所有标签名(小写) */
function tags(node: StubNode, acc: string[] = []): string[] {
  if (node.tagName !== '#text' && node.tagName !== '#fragment') {
    acc.push(node.tagName.toLowerCase());
  }
  for (const c of node.children) tags(c, acc);
  return acc;
}

/** 找第一个指定标签的节点 */
function find(node: StubNode, tag: string): StubNode | null {
  if (node.tagName.toLowerCase() === tag) return node;
  for (const c of node.children) {
    const hit = find(c, tag);
    if (hit) return hit;
  }
  return null;
}

describe('安全:不可信文本永不成为 HTML', () => {
  it('script 标签只是文本,不进渲染树', () => {
    const r = md.render('<script>alert(1)</script>');
    expect(tags(r)).not.toContain('script');
    // 原文必须仍然看得见 —— 吞掉比显示更糟(用户不知道模型说了什么)
    expect(r.textContent).toContain('alert(1)');
  });

  it('img onerror 这类注入同样只是文本', () => {
    const r = md.render('<img src=x onerror=alert(1)>');
    expect(tags(r)).not.toContain('img');
    expect(r.textContent).toContain('onerror');
  });

  it('javascript: 链接不渲染成 <a>', () => {
    const r = md.render('[点我](javascript:alert(1))');
    expect(tags(r)).not.toContain('a');
    expect(r.textContent).toContain('javascript:');
  });

  it('data: 链接不渲染成 <a>', () => {
    const r = md.render('[图](data:text/html,<script>x</script>)');
    expect(tags(r)).not.toContain('a');
  });

  it('http/https/mailto 是允许的', () => {
    for (const url of ['https://example.com', 'http://example.com', 'mailto:a@b.c']) {
      const r = md.render(`[链接](${url})`);
      const a = find(r, 'a');
      expect(a, url).not.toBeNull();
      expect(a!.href).toBe(url);
    }
  });

  it('图片语法不产生 <img> —— 否则模型输出能触发外部请求(信标)', () => {
    const r = md.render('![说明](https://tracker.example.com/x.png)');
    expect(tags(r)).not.toContain('img');
  });
});

describe('代码块', () => {
  it('渲染成 pre>code 并保留语言标记', () => {
    const r = md.render('```python\nprint("hi")\n```');
    const pre = find(r, 'pre');
    expect(pre).not.toBeNull();
    expect(pre!.dataset.lang).toBe('python');
    expect(find(r, 'code')!.textContent).toBe('print("hi")');
  });

  it('未闭合围栏仍显示内容 —— 流式中途必然出现这种状态', () => {
    const r = md.render('看这段:\n```js\nconst a = 1;');
    expect(r.textContent).toContain('const a = 1;');
  });

  it('代码块内的 markdown 标记不被解析', () => {
    const r = md.render('```\n**星号**和`反引号`\n```');
    expect(tags(r)).not.toContain('strong');
    expect(find(r, 'code')!.textContent).toBe('**星号**和`反引号`');
  });

  it('多行缩进原样保留', () => {
    const r = md.render('```\ndef f():\n    return 1\n```');
    expect(find(r, 'code')!.textContent).toBe('def f():\n    return 1');
  });
});

describe('行内标记', () => {
  it('粗体、斜体、行内代码、删除线', () => {
    const t = tags(md.render('**粗** *斜* `码` ~~删~~'));
    expect(t).toContain('strong');
    expect(t).toContain('em');
    expect(t).toContain('code');
    expect(t).toContain('del');
  });

  it('行内代码优先 —— `**x**` 里的星号原样显示', () => {
    const r = md.render('`**不是粗体**`');
    expect(tags(r)).not.toContain('strong');
    expect(r.textContent).toBe('**不是粗体**');
  });

  it('粗体内部可以嵌套行内代码', () => {
    const r = md.render('**看 `code` 这里**');
    const t = tags(r);
    expect(t).toContain('strong');
    expect(t).toContain('code');
  });
});

describe('块级结构', () => {
  it('标题按级数映射 h1..h6', () => {
    expect(tags(md.render('# 一'))).toContain('h1');
    expect(tags(md.render('### 三'))).toContain('h3');
    expect(tags(md.render('###### 六'))).toContain('h6');
  });

  it('无序列表:连续项归为一个 ul', () => {
    const r = md.render('- 甲\n- 乙\n- 丙');
    expect(tags(r)).toContain('ul');
    expect(tags(r).filter(t => t === 'li')).toHaveLength(3);
  });

  it('有序列表 → ol', () => {
    expect(tags(md.render('1. 甲\n2. 乙'))).toContain('ol');
  });

  it('分隔线不被当成列表 —— --- 也能匹配 UL 的模式', () => {
    const t = tags(md.render('---'));
    expect(t).toContain('hr');
    expect(t).not.toContain('ul');
  });

  it('表格:表头与单元格数量正确', () => {
    const r = md.render('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
    const t = tags(r);
    expect(t).toContain('table');
    expect(t.filter(x => x === 'th')).toHaveLength(2);
    expect(t.filter(x => x === 'td')).toHaveLength(4);
  });

  it('引用 → blockquote', () => {
    expect(tags(md.render('> 一行\n> 两行'))).toContain('blockquote');
  });
});

describe('边界输入', () => {
  it('空字符串产出空结果,不抛异常', () => {
    const r = md.render('');
    expect(r.children).toHaveLength(0);
  });

  it('null / undefined 不抛异常', () => {
    expect(md.render(null).children).toHaveLength(0);
    expect(md.render(undefined).children).toHaveLength(0);
  });

  it('into() 会先清空目标节点', () => {
    const node = mkNode('div');
    md.into(node, '第一次');
    md.into(node, '第二次');
    expect(node.textContent).toBe('第二次');
  });
});
