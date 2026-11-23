import { bridge, call } from '../api.js';
import { field, h } from '../dom.js';
import { navigate, taskLink } from '../router.js';

/**
 * 新建任务：选项目（主进程弹系统对话框）、写目标、可选检查命令。
 * 检查命令分两栏（可执行文件 + 每行一个参数），不按空格拆分；填写后必须勾选确认才会运行。
 */
export function newTaskView(): HTMLElement {
  // 每次打开表单一个幂等键：重复点击提交只建一个任务
  const idempotencyKey = crypto.randomUUID();
  const error = h('p', { class: 'error', role: 'alert' });
  const project = h('input', { id: 'project', name: 'project', readonly: true, required: true, placeholder: '点击「选择」', 'aria-describedby': 'project-hint' });
  const confirmBox = h(
    'div',
    { class: 'check-confirm', hidden: true },
    h('label', {}, h('input', { type: 'checkbox', id: 'check-confirmed' }), ' 我已确认上面的检查命令'),
    h(
      'p',
      { class: 'hint' },
      '检查命令由 PalDock 在每次执行结束后、在任务的 worktree 里直接运行：它以你的账户权限运行、可以联网，不经过执行器的沙箱和审批。只填写你信任的命令。',
    ),
  );

  const form = h(
    'form',
    { class: 'new-task', 'aria-labelledby': 'new-title' },
    h('h2', { id: 'new-title' }, '新建任务'),
    h('label', { for: 'project' }, '项目目录（git 仓库根目录）'),
    h('div', { class: 'row' }, project, h('button', { type: 'button', onclick: pick }, '选择…')),
    h('p', { id: 'project-hint', class: 'hint' }, 'PalDock 会在数据目录下为任务建立独立的 worktree 和 paldock/ 分支，不改动你的当前分支。'),
    h('label', { for: 'goal' }, '目标'),
    h('textarea', { id: 'goal', rows: 6, required: true, 'data-keep': 'goal', placeholder: '例如：给登录页加「记住我」，并补测试' }),
    h('fieldset', {}, h('legend', {}, '检查命令（可选）'),
      h('label', { for: 'check-exe' }, '可执行文件'),
      h('input', { id: 'check-exe', 'data-keep': 'check-exe', placeholder: '例如：pnpm', oninput: syncConfirm }),
      h('label', { for: 'check-args' }, '参数（每行一个）'),
      h('textarea', { id: 'check-args', rows: 3, 'data-keep': 'check-args', placeholder: 'test' }),
      confirmBox,
    ),
    error,
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, '创建并开始执行'), h('button', { type: 'button', onclick: () => navigate('#/tasks') }, '返回')),
  );

  async function pick() {
    const path = await bridge().pickProject();
    if (path) project.value = path;
  }
  function syncConfirm() {
    confirmBox.hidden = field<HTMLInputElement>(form, '#check-exe').value.trim() === '';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const executable = field<HTMLInputElement>(form, '#check-exe').value.trim();
    const args = field<HTMLTextAreaElement>(form, '#check-args').value.split(/\r?\n/).filter((line) => line !== '');
    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    submit.disabled = true;
    try {
      const detail = await call('task.create', {
        rootPath: project.value,
        goal: field<HTMLTextAreaElement>(form, '#goal').value,
        ...(executable ? { check: { executable, args } } : {}),
        checkConfirmed: field<HTMLInputElement>(form, '#check-confirmed').checked,
        idempotencyKey,
      });
      navigate(taskLink(detail.task.id));
    } catch (e) {
      error.textContent = (e as Error).message;
      submit.disabled = false;
    }
  });
  return form;
}
