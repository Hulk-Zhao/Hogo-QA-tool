/**
 * aiChatStore 测试（P3-B）。
 *
 * 缺陷背景：问完问题切到别的页面再回来，对话记录整段消失。
 * 根因是 entries 存在组件 useState 里，路由切换卸载组件即销毁。
 * 本文件锁定「状态住在 store、与组件生命周期解耦」这一契约。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { nextEntryId, useAiChatStore, type ChatEntry } from '@/store/aiChatStore';

function entry(id: string, text: string): ChatEntry {
  return { id, role: 'user', text };
}

describe('aiChatStore', () => {
  beforeEach(() => {
    useAiChatStore.setState({ entries: [], question: '', allowRaw: false, loading: false });
  });

  it('appendEntry 逐条累加，且保持顺序', () => {
    const { appendEntry } = useAiChatStore.getState();
    appendEntry(entry('a', '第一句'));
    appendEntry(entry('b', '第二句'));
    const list = useAiChatStore.getState().entries;
    expect(list.map((e) => e.text)).toEqual(['第一句', '第二句']);
  });

  it('appendEntry 不原地改写数组（保证 React 能感知到变化）', () => {
    const before = useAiChatStore.getState().entries;
    useAiChatStore.getState().appendEntry(entry('a', 'x'));
    expect(useAiChatStore.getState().entries).not.toBe(before);
  });

  it('nextEntryId 单调递增且不重号（计数器不随组件卸载重置）', () => {
    const ids = new Set([nextEntryId(), nextEntryId(), nextEntryId(), nextEntryId()]);
    expect(ids.size).toBe(4);
  });

  it('question / allowRaw / loading 都存在 store 里，可跨组件存活', () => {
    const s = useAiChatStore.getState();
    s.setQuestion('这批数据受控吗？');
    s.setAllowRaw(true);
    s.setLoading(true);
    const after = useAiChatStore.getState();
    expect(after.question).toBe('这批数据受控吗？');
    expect(after.allowRaw).toBe(true);
    expect(after.loading).toBe(true);
  });

  it('clearChat 同时清空记录、输入框与在途标记', () => {
    const s = useAiChatStore.getState();
    s.appendEntry(entry('a', 'hello'));
    s.setQuestion('残留问题');
    s.setLoading(true);
    useAiChatStore.getState().clearChat();
    const after = useAiChatStore.getState();
    expect(after.entries).toEqual([]);
    expect(after.question).toBe('');
    expect(after.loading).toBe(false);
  });
});
