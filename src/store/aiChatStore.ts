/**
 * aiChatStore —— AI 助手会话记录（本轮 P3-B）。
 *
 * 缺陷背景（用户实测）：问完问题后点侧边栏切到别的页面再回来，对话记录**整段消失**。
 * 根因：`entries` 是 AiAssistantPage 组件内的 `useState`，路由切换会卸载组件、
 * state 随之销毁。同一文件里的「AI 全面诊断」早就为此迁到了 diagnosisStore
 * （需求原话是「不要 useState」），唯独对话列表当时漏掉了。
 *
 * 契约：
 *  1. 会话记录 / 输入框内容 / 「允许发送原始明细」开关都**不在组件 state 里**，
 *     路由切换与组件重新挂载都不丢；
 *  2. `loading` 也放在这里：请求在途时切页，回来仍能看到「思考中」；
 *     且响应回来时写入的是 store —— 组件已卸载也不会把回复丢掉；
 *  3. **刻意不落盘**：会话正文可能包含 AI 生成的统计结论与用户问题，
 *     落盘会扩大本机留存面（刷新即清空是有意为之）。若将来要「刷新也保留」，
 *     走 diagnosisStore 那套「注入持久层 + sanitize」的写法单独评估。
 */

import { create } from 'zustand';

/** 会话消息。 */
export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 本次请求发送的数据范围。 */
  scope?: 'summary' | 'raw';
  /** 发送字段清单。 */
  sentFields?: string[];
  ok?: boolean;
  /** 失败时服务端返回的原文（如 `model is required`），供用户自助定位。 */
  serverDetail?: string;
}

/**
 * 把整段会话拼成可复制的纯文本（P7「对话可以复制」）。
 *
 * 以「角色：正文」分行，条目之间空一行 —— 粘到聊天窗口 / 邮件里仍然读得懂。
 * 纯函数放在 store 模块（而不是页面组件里），是为了能直接单测格式契约。
 *
 * @param entries 会话消息
 * @returns 纯文本（空会话返回空串）
 */
export function formatTranscript(entries: ChatEntry[]): string {
  return entries
    .map((e) => `${e.role === 'user' ? '我' : 'AI 助手'}：${e.text}`)
    .join('\n\n');
}
/** 会话内唯一 id。计数器放在 store 模块：页面重新挂载也不会重号。 */
let entrySeq = 0;
export function nextEntryId(): string {
  entrySeq += 1;
  return `entry-${entrySeq}`;
}

interface AiChatState {
  /** 对话记录（切页/重新挂载不丢）。 */
  entries: ChatEntry[];
  /** 输入框内容（切页回来还在）。 */
  question: string;
  /** 是否允许发送原始明细。 */
  allowRaw: boolean;
  /** 是否有请求在途。 */
  loading: boolean;
  appendEntry: (entry: ChatEntry) => void;
  setQuestion: (question: string) => void;
  setAllowRaw: (allowRaw: boolean) => void;
  setLoading: (loading: boolean) => void;
  /** 清空对话（记录跨页存活后，用户需要一条显式的「倒掉」出口）。 */
  clearChat: () => void;
}

export const useAiChatStore = create<AiChatState>((set) => ({
  entries: [],
  question: '',
  allowRaw: false,
  loading: false,
  appendEntry: (entry) => set((s) => ({ entries: [...s.entries, entry] })),
  setQuestion: (question) => set({ question }),
  setAllowRaw: (allowRaw) => set({ allowRaw }),
  setLoading: (loading) => set({ loading }),
  clearChat: () => set({ entries: [], question: '', loading: false }),
}));
