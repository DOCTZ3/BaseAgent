import { describe, it, expect, vi } from 'vitest';
import { RequestHelpTool } from './request-help.js';
import type { ToolContext } from '../../contract.js';
import type { Logger } from '../../../platform/index.js';

const logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as unknown as Logger;

const ctx = {
  sessionId: 'test',
  logger,
  signal: new AbortController().signal,
  confirm: async () => true,
  executors: {},
} as ToolContext;

describe('RequestHelpTool', () => {
  it('description pushes login and verification cases to the human handoff path', () => {
    const tool = new RequestHelpTool();

    expect(tool.description).toContain('登录');
    expect(tool.description).toContain('验证码');
    expect(tool.description).toContain('401');
    expect(tool.description).toContain('不要继续用 goto');
  });

  it('tells the model to stop the turn after asking the user', async () => {
    const tool = new RequestHelpTool();

    const result = await tool.run({
      what_to_do: '请在浏览器里完成登录',
      why: '目标页面需要登录态',
    }, ctx);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain('本轮就结束回答');
    expect(JSON.stringify(result.data)).toContain('不要在这一轮继续调用工具');
  });
});
