// @vitest-environment jsdom
/**
 * ProjectLibraryPage 测试（P1-04；T05 验收要点 5）。
 *
 * 通过注入 `MemoryRepository` 覆盖：加载列表、搜索、重命名、复制、删除。
 * 不触碰 IndexedDB / 浏览器 API。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { MemoryRepository } from '@/data/repositories/memoryRepository';
import type { Project } from '@/data/schema';
import { CURRENT_SCHEMA_VERSION } from '@/data/schema';
import ProjectLibraryPage from '@/ui/pages/ProjectLibraryPage';

let repo: MemoryRepository;

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasets: [
      {
        id: `${id}_ds`,
        projectId: id,
        name: 'ds',
        sourceType: 'xlsx',
        importedAt: '2026-01-01T00:00:00.000Z',
        rawFileName: 'f.xlsx',
        characteristics: [],
        defectRecords: [],
      },
    ],
    analysisConfigs: [],
    aiUsageLogs: [],
  };
}

function renderPage(): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ProjectLibraryPage repository={repo} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('ProjectLibraryPage', () => {
  beforeEach(() => {
    repo = new MemoryRepository();
  });

  it('空库 → 显示空状态', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('暂无项目')).toBeInTheDocument();
    });
  });

  it('加载已有项目并展示名称', async () => {
    await repo.saveProject(makeProject('p1', '外壳长度分析'));
    await repo.saveProject(makeProject('p2', '转轴直径分析'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('外壳长度分析')).toBeInTheDocument();
    });
    expect(screen.getByText('转轴直径分析')).toBeInTheDocument();
  });

  it('搜索过滤：无匹配 → 未找到', async () => {
    await repo.saveProject(makeProject('p1', '外壳长度分析'));
    renderPage();
    await waitFor(() => expect(screen.getByText('外壳长度分析')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: 'zzz' } });
    await waitFor(() => {
      expect(screen.getByText('未找到匹配项目')).toBeInTheDocument();
    });
  });

  it('复制项目 → 列表出现「副本」', async () => {
    await repo.saveProject(makeProject('p1', '外壳长度分析'));
    renderPage();
    await waitFor(() => expect(screen.getByText('外壳长度分析')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('复制项目'));
    await waitFor(() => {
      expect(screen.getByText('外壳长度分析 副本')).toBeInTheDocument();
    });
  });

  it('重命名项目 → 列表更新', async () => {
    await repo.saveProject(makeProject('p1', '外壳长度分析'));
    renderPage();
    await waitFor(() => expect(screen.getByText('外壳长度分析')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('重命名项目'));
    const input = await screen.findByLabelText('项目名称');
    fireEvent.change(input, { target: { value: '新名字' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => {
      expect(screen.getByText('新名字')).toBeInTheDocument();
    });
  });

  it('删除项目（二次确认）→ 列表移除', async () => {
    await repo.saveProject(makeProject('p1', '待删除项目'));
    renderPage();
    await waitFor(() => expect(screen.getByText('待删除项目')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('删除项目'));
    await waitFor(() => {
      expect(screen.getByText(/确认删除项目/)).toBeInTheDocument();
    });
    // 对话框中的「删除」按钮
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(screen.queryByText('待删除项目')).not.toBeInTheDocument();
    });
  });
});
