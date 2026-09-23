// @vitest-environment jsdom
/**
 * 数据导入页交互测试（PRD P0-15/P0-16）。
 *
 * 覆盖：粘贴 CSV → 解析 → 列映射 → 校验统计展示；
 * 以及**导入即落盘**（本轮 P0 修复：项目库此前永远是空的，见记忆第二十一节）。
 *
 * 证伪立场：
 *  - 删掉 `ImportPage.handleConfirm` 里的 `persist()` 调用 → 「落盘 / 两次导入」用例必须变红；
 *  - 把 `projectStore.setDataset` 的项目 id 改回硬编码常量 → 「两次导入 → 两条记录」必须变红。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useProjectStore } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import { getSharedRepositoryHandle, resetSharedRepositoryHandle } from '@/data/repositories/handle';
import { LAST_PROJECT_STORAGE_KEY } from '@/ui/bootstrap/projectSession';
import type { ProjectSummary } from '@/data/schema';
import ImportPage from '@/ui/pages/ImportPage';

function renderPage(): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ImportPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** 造一段可解析的粘贴文本（物料名称 + 测量值，每个特性 2 个测量值）。 */
function pasteText(characteristics: string[]): string {
  const lines = ['物料名称,测量值'];
  for (const name of characteristics) {
    lines.push(`${name},10.02`);
    lines.push(`${name},10.05`);
  }
  return lines.join('\n');
}

/** 当前项目库里的项目（走真实仓库句柄，与页面同一条链路）。 */
async function listLibrary(): Promise<ProjectSummary[]> {
  const handle = await getSharedRepositoryHandle();
  return handle.repository.listProjects();
}

/** 走完整「粘贴 → 解析 → 确认导入」流程（不负责渲染页面）。 */
async function runPasteImport(text: string): Promise<void> {
  fireEvent.click(screen.getByText('粘贴 CSV'));
  fireEvent.change(screen.getByTestId('paste-input'), { target: { value: text } });
  fireEvent.click(screen.getByText('解析'));
  await waitFor(() => {
    expect(screen.getByText('校验结果')).toBeInTheDocument();
  });
  fireEvent.click(screen.getByText('确认导入并分析'));
}

/** 等待项目库出现 `count` 条记录。 */
async function expectLibrarySize(count: number): Promise<void> {
  await waitFor(async () => {
    expect(await listLibrary()).toHaveLength(count);
  });
}

describe('ImportPage —— 粘贴导入', () => {
  beforeEach(() => {
    useProjectStore.getState().clearDataset();
  });

  it('渲染拖拽区与页签', () => {
    renderPage();
    expect(screen.getByTestId('import-page')).toBeInTheDocument();
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    expect(screen.getByText('文件导入')).toBeInTheDocument();
    expect(screen.getByText('粘贴 CSV')).toBeInTheDocument();
  });

  it('粘贴 CSV → 解析 → 展示校验统计与预览', async () => {
    renderPage();
    fireEvent.click(screen.getByText('粘贴 CSV'));

    const input = screen.getByTestId('paste-input');
    fireEvent.change(input, {
      target: { value: '物料名称,测量值\n外壳长度,10.02\n外壳长度,10.05\n转轴直径,5.01\n外壳长度,' },
    });
    fireEvent.click(screen.getByText('解析'));

    await waitFor(() => {
      expect(screen.getByText('校验结果')).toBeInTheDocument();
    });

    // 校验统计：2 特性、3 测量、1 空值
    expect(screen.getByText('特性数')).toBeInTheDocument();
    expect(screen.getByText('剔除空值数')).toBeInTheDocument();
    const preview = screen.getByTestId('import-preview-table');
    expect(within(preview).getAllByText('外壳长度').length).toBeGreaterThan(0);
  });

  it('识别旧格式并显示自动识别标记', async () => {
    renderPage();
    fireEvent.click(screen.getByText('粘贴 CSV'));
    fireEvent.change(screen.getByTestId('paste-input'), {
      target: { value: '物料名称,测量值\n外壳长度,10.02\n外壳长度,10.05' },
    });
    fireEvent.click(screen.getByText('解析'));

    await waitFor(() => {
      expect(screen.getByText('旧格式自动识别')).toBeInTheDocument();
    });
  });
});

describe('ImportPage —— 导入即落盘（项目库不再为空）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSharedRepositoryHandle();
    useProjectStore.setState({
      project: null,
      projectName: '未命名项目',
      dataset: null,
      selectedCharacteristicId: null,
      aiUsageLogs: [],
    });
    useUiStore.setState({ toasts: [] });
  });

  afterEach(() => {
    localStorage.clear();
    resetSharedRepositoryHandle();
  });

  it('确认导入后项目真的落盘，并记录「上次项目」', async () => {
    renderPage();
    await runPasteImport(pasteText(['外壳长度', '转轴直径']));

    await expectLibrarySize(1);
    const list = await listLibrary();
    expect(list[0].datasetCount).toBe(1);
    expect(list[0].characteristicCount).toBe(2);
    expect(list[0].name).toBe('粘贴数据');

    // 顺带钉住写入侧：没有它，启动自动恢复永远读不到记录（死代码）。
    const raw = localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
    expect(raw, '保存成功后必须记录「上次项目」').not.toBeNull();
    expect((JSON.parse(raw as string) as { projectId: string }).projectId).toBe(list[0].id);
  });

  it('连续导入两次 → 项目库两条独立记录（不互相覆盖）', async () => {
    renderPage();
    await runPasteImport(pasteText(['外壳长度', '转轴直径']));
    await expectLibrarySize(1);

    await runPasteImport(pasteText(['主轴跳动']));
    await expectLibrarySize(2);

    const list = await listLibrary();
    expect(new Set(list.map((p) => p.id)).size).toBe(2);
    expect(new Set(list.map((p) => p.characteristicCount))).toEqual(new Set([1, 2]));
  });

  it('成功提示只发一条：导入结果与落盘结果合并，不重复提示', async () => {
    renderPage();
    fireEvent.click(screen.getByText('粘贴 CSV'));
    fireEvent.change(screen.getByTestId('paste-input'), { target: { value: pasteText(['外壳长度']) } });
    fireEvent.click(screen.getByText('解析'));
    await waitFor(() => {
      expect(screen.getByText('校验结果')).toBeInTheDocument();
    });

    useUiStore.setState({ toasts: [] });
    fireEvent.click(screen.getByText('确认导入并分析'));

    await waitFor(() => {
      const msgs = useUiStore.getState().toasts.map((t) => t.message);
      expect(msgs.some((m) => m.includes('已保存到项目库'))).toBe(true);
    });

    const msgs = useUiStore.getState().toasts.map((t) => t.message);
    expect(msgs.filter((m) => m.includes('已保存到项目库'))).toHaveLength(1);
    // 数量与真实导入结果一致，且没有第二条「已保存项目…」重复提示。
    expect(msgs.some((m) => m.includes('1 个特性') && m.includes('2 个测量值'))).toBe(true);
    expect(msgs.filter((m) => m.includes('已保存项目'))).toHaveLength(0);
  });

  it('落盘失败不阻断导入：数据仍在内存里可用，并给出失败提示', async () => {
    renderPage();
    fireEvent.click(screen.getByText('粘贴 CSV'));
    fireEvent.change(screen.getByTestId('paste-input'), { target: { value: pasteText(['外壳长度']) } });
    fireEvent.click(screen.getByText('解析'));
    await waitFor(() => {
      expect(screen.getByText('校验结果')).toBeInTheDocument();
    });

    // 先把仓库后端解析定：localStorage 探测本身也要写一次，若在探测前就打断
    // setItem，后端会降级成内存仓库（保存反而成功），这条失败路径就测不到了。
    const handle = await getSharedRepositoryHandle();
    expect(handle.backend).toBe('localstorage');

    // 让本地存储在保存时失败（模拟配额耗尽 / 被禁用）。
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    useUiStore.setState({ toasts: [] });
    try {
      fireEvent.click(screen.getByText('确认导入并分析'));
      await waitFor(() => {
        const msgs = useUiStore.getState().toasts.map((t) => t.message);
        expect(msgs.some((m) => m.includes('保存失败'))).toBe(true);
      });
      // 数据没有丢：内存里的数据集与项目都还在（用户可以直接继续分析）。
      expect(useProjectStore.getState().dataset).not.toBeNull();
      expect(useProjectStore.getState().project).not.toBeNull();
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});
