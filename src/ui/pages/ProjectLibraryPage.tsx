/**
 * ProjectLibraryPage —— 项目库管理（P1-04；T05 验收要点 5）。
 *
 * 基于 `ProjectRepository`（IndexedDB / localStorage 降级 / 内存降级）实现：
 * 搜索 / 打开 / 重命名 / 复制 / 删除。
 *
 * 能力探测使用异步真实探测（`createRepositoryAsync`），可正确识别 `file://`
 * 双击离线模式下 IndexedDB 不可用，从而降级到 localStorage / 内存并给出提示。
 *
 * 数据主权：项目库全部数据存于本机，不涉及任何网络请求。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Search as SearchIcon,
  ContentCopy as CopyIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  FolderOpen as OpenIcon,
  Add as AddIcon,
} from '@mui/icons-material';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createRepositoryAsync,
  degradationHint,
  type RepositoryHandle,
} from '@/data/repositories';
import type { ProjectRepository } from '@/data/repositories/types';
import type { Project, ProjectSummary } from '@/data/schema';
import { useProjectStore } from '@/store/projectStore';
import EmptyState from '@/ui/components/EmptyState';
import ConfirmDialog from '@/ui/components/ConfirmDialog';

/**
 * 惰性单例仓库句柄（与 useProjectPersistence 共用异步工厂，真实能力探测只做一次）。
 */
let handlePromise: Promise<RepositoryHandle> | null = null;

function getHandle(): Promise<RepositoryHandle> {
  if (handlePromise === null) {
    handlePromise = createRepositoryAsync();
  }
  return handlePromise;
}

/** 注入仓库且被标记降级时的兜底提示（无后端信息可用）。 */
const FALLBACK_DEGRADED_HINT =
  '当前环境不支持 IndexedDB，项目仅在本会话内有效。请及时导出 JSON 项目包以持久保存。';

/** 本次使用的仓库与降级提示。 */
interface ResolvedRepository {
  repository: ProjectRepository;
  degraded: boolean;
  hint: string;
}

/** 页面属性（可注入仓库，便于测试）。 */
export interface ProjectLibraryPageProps {
  /** 可注入的仓库（默认走惰性单例工厂）。 */
  repository?: ProjectRepository;
  /** 注入仓库时的降级标记。 */
  degraded?: boolean;
}

/**
 * 解析本次使用的仓库与降级提示。
 *
 * @param injectedRepository 注入的仓库（无则走惰性单例工厂）
 * @param injectedDegraded 注入仓库时的降级标记
 * @returns { repository, degraded, hint }
 */
async function resolveRepository(
  injectedRepository: ProjectRepository | undefined,
  injectedDegraded: boolean | undefined,
): Promise<ResolvedRepository> {
  if (injectedRepository) {
    const degraded = injectedDegraded ?? false;
    return {
      repository: injectedRepository,
      degraded,
      hint: degraded ? FALLBACK_DEGRADED_HINT : '',
    };
  }
  const handle = await getHandle();
  return { repository: handle.repository, degraded: handle.degraded, hint: degradationHint(handle) };
}

/** 格式化 ISO 时间为本地可读文本。 */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN');
}

/**
 * 渲染项目库页。
 *
 * @param props 页面属性（可注入仓库）
 * @returns 页面元素
 */
export default function ProjectLibraryPage(props: ProjectLibraryPageProps = {}): ReactElement {
  const { repository: injectedRepository, degraded: injectedDegraded } = props;
  const navigate = useNavigate();
  const setProject = useProjectStore((s) => s.setProject);
  const currentProjectId = useProjectStore((s) => s.project?.id ?? null);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<ResolvedRepository | null>(null);

  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);

  const mounted = useRef(true);

  /** 解析仓库（注入优先，否则异步惰性单例；含真实能力探测）。 */
  useEffect(() => {
    let active = true;
    void resolveRepository(injectedRepository, injectedDegraded).then((resolved) => {
      if (active) {
        setRepo(resolved);
      }
    });
    return () => {
      active = false;
    };
    // 仅在注入项变化时重新解析，避免 props 对象身份变化引发循环。
  }, [injectedRepository, injectedDegraded]);

  /** 刷新列表。 */
  const refresh = useCallback(async (): Promise<void> => {
    if (!repo) {
      return;
    }
    try {
      const list = await repo.repository.listProjects();
      if (mounted.current) {
        setProjects(list);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : '项目库读取失败。');
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, [repo]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    if (q.length === 0) {
      return sorted;
    }
    return sorted.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  /** 打开项目。 */
  const openProject = async (summary: ProjectSummary): Promise<void> => {
    if (!repo) {
      return;
    }
    const { repository } = repo;
    try {
      const project: Project | null = await repository.getProject(summary.id);
      if (project) {
        setProject(project);
        navigate('/import');
      } else {
        setError('项目不存在或已删除。');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '打开项目失败。');
    }
  };

  /** 复制项目。 */
  const duplicateProject = async (summary: ProjectSummary): Promise<void> => {
    if (!repo) {
      return;
    }
    const { repository } = repo;
    try {
      await repository.duplicateProject(summary.id, `${summary.name} 副本`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '复制项目失败。');
    }
  };

  /** 删除项目。 */
  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || !repo) {
      return;
    }
    const { repository } = repo;
    try {
      await repository.deleteProject(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除项目失败。');
      setDeleteTarget(null);
    }
  };

  /** 提交重命名。 */
  const confirmRename = async (): Promise<void> => {
    if (!renameTarget || !repo) {
      return;
    }
    const name = renameDraft.trim();
    if (name.length === 0) {
      setRenameTarget(null);
      return;
    }
    const { repository } = repo;
    try {
      const project = await repository.getProject(renameTarget.id);
      if (project) {
        await repository.saveProject({ ...project, name, updatedAt: new Date().toISOString() });
      }
      setRenameTarget(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '重命名失败。');
      setRenameTarget(null);
    }
  };

  return (
    <Stack spacing={2.5} data-testid="project-library-page">
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Typography variant="h6" fontWeight={600}>
          项目库
        </Typography>
        <Button startIcon={<AddIcon />} variant="outlined" onClick={() => navigate('/import')}>
          新建项目（前往导入）
        </Button>
      </Stack>

      {repo && repo.degraded ? (
        <Alert severity="warning" data-testid="library-degraded">
          {repo.hint || FALLBACK_DEGRADED_HINT}
        </Alert>
      ) : null}
      {error ? (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <TextField
        size="small"
        fullWidth
        placeholder="搜索项目名称…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        inputProps={{ 'aria-label': '搜索项目' }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
      />

      {loading ? (
        <Typography variant="body2" color="text.secondary">
          加载中…
        </Typography>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={query.trim().length > 0 ? '未找到匹配项目' : '暂无项目'}
          description={
            query.trim().length > 0
              ? '尝试更换关键词。'
              : '导入数据并保存后，项目会出现在此列表中。'
          }
        />
      ) : (
        <Stack spacing={1.5} data-testid="project-list">
          {filtered.map((p) => (
            <Card key={p.id} variant="outlined" data-testid={`project-item-${p.id}`}>
              <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                  <Box sx={{ minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="subtitle1" fontWeight={600} noWrap>
                        {p.name}
                      </Typography>
                      {p.id === currentProjectId ? (
                        <Chip size="small" color="primary" label="当前项目" />
                      ) : null}
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      数据集 {p.datasetCount} · 特性 {p.characteristicCount} · 更新于 {fmtTime(p.updatedAt)}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={0.5}>
                    <Tooltip title="打开">
                      <IconButton size="small" aria-label="打开项目" onClick={() => void openProject(p)}>
                        <OpenIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="重命名">
                      <IconButton
                        size="small"
                        aria-label="重命名项目"
                        onClick={() => {
                          setRenameTarget(p);
                          setRenameDraft(p.name);
                        }}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="复制">
                      <IconButton
                        size="small"
                        aria-label="复制项目"
                        onClick={() => void duplicateProject(p)}
                      >
                        <CopyIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="删除">
                      <IconButton
                        size="small"
                        aria-label="删除项目"
                        color="error"
                        onClick={() => setDeleteTarget(p)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      {/* 重命名对话框 */}
      <Dialog open={renameTarget !== null} onClose={() => setRenameTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>重命名项目</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            margin="dense"
            label="项目名称"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            inputProps={{ 'aria-label': '项目名称' }}
          />
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setRenameTarget(null)}>
            取消
          </Button>
          <Button variant="contained" onClick={() => void confirmRename()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除项目"
        confirmColor="error"
        confirmText="删除"
        content={`确认删除项目「${deleteTarget?.name ?? ''}」？该操作不可撤销。`}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </Stack>
  );
}
