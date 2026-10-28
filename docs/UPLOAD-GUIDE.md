# 第一次上传到 GitHub — 手把手

这份文档写给**从来没在 GitHub 上传过东西**的人。Windows 环境，全程大约 15 分钟。
你只需要动两处「点鼠标/输密码」的地方，其余命令可以原样复制。

项目已经在 `E:\deepseek\dsh-spend-meter`，是个完整的 git 仓库（4 次提交、37 个文件、`npm test` 全绿），
**不需要重新初始化**。

---

## 第 0 步：确认你有 GitHub 账号（2 分钟）

1. 打开 <https://github.com>。
2. 有账号 → 点右上角 **Sign in** 登录。
3. 没账号 → 点 **Sign up**，填邮箱、密码、用户名。用户名会出现在仓库地址里
   （例如用户名是 `xiaoming`，仓库地址就是 `https://github.com/xiaoming/dsh-spend-meter`），
   以后改起来麻烦，想好再填。注册完去邮箱点验证链接。

> 记住你的**用户名**和**邮箱**，第 2、3 步要用。

---

## 第 1 步：在网页上建一个空仓库（1 分钟）

1. 登录后打开 <https://github.com/new>。
2. **Repository name** 填：`dsh-spend-meter`
3. **Description**（可选）填：
   `Live DeepSeek balance, per-turn charge and today's spend in a draggable DSH panel — measured from the billing counter.`
4. 可见性选 **Public**（私有仓库不能发 npm、也没有社交预览这些）。
5. 下面三个复选框**全部不要勾**（`Add a README`、`Add .gitignore`、`Choose a license`）——
   仓库里已经有了，勾了会造成冲突。
6. 点 **Create repository**。

建完你会看到一个「quick setup」页面，上面有仓库地址，形如
`https://github.com/<你的用户名>/dsh-spend-meter.git`。先放着，第 3 步用。

---

## 第 2 步：占位符 —— 已经替你改好了

仓库里原本有 7 个文件写着 `github.com/USER` 占位符，现在都已替换成 **`github.com/lx950`**
（`npm pack --dry-run` 之前也验证过）。你可以用下面这条命令确认——**必须没有任何输出**：

```bash
cd /e/deepseek/dsh-spend-meter
grep -rn "github.com/USER" . --exclude-dir=.git --exclude-dir=node_modules
```

有输出 = 还有漏的，把那几行贴给我；没输出 = 直接进第 3 步。

## 第 3 步：设置提交作者，然后推送（3 分钟）

### 3.1 设作者

前面几次提交是用占位身份（`dsh-spend-meter <noreply@example.com>`）写的，公开发布前换成你自己：

```bash
cd /e/deepseek/dsh-spend-meter
git config user.name  "你的名字或用户名"
git config user.email "你的GitHub邮箱"
```

### 3.2 关联远程仓库

把最后那段换成第 1 步建好的地址（注意是 `https://`，不是 `git@`）：

```bash
git remote add origin https://github.com/你的用户名/dsh-spend-meter.git
git remote -v          # 打印两行 fetch/push，地址正确就行
```

### 3.3 推送

```bash
git push -u origin main
```

第一次会弹出 **Git Credential Manager** 窗口：

1. 选 **Sign in with your browser**（用浏览器登录）；
2. 浏览器打开 GitHub 授权页 → 点 **Authorize**；
3. 回到窗口，显示 `Successfully authenticated` → 关闭。

然后终端会打印 `main -> main` 之类的行。**这时文件已经在 GitHub 上了**，刷新网页就能看到。

> 如果提示 `remote origin already exists`，说明之前加过，用
> `git remote set-url origin https://github.com/你的用户名/dsh-spend-meter.git` 改地址即可。
> 如果提示 `src refspec main does not match any`，确认分支名：`git branch -M main` 再推。

---

## 第 4 步：上传后要做的 4 件事（决定别人能不能找到你）

### 4.1 填 About 和 topics

在仓库首页右侧点 **⚙️（About 旁边的齿轮）**：

- **Description**：粘贴上面第 1 步那句英文
- **Website**：留空
- **Topics**（一个一个加，回车确认）：
  `deepseek` `deepseek-harness` `dsh` `dsh-plugin` `llm-cost` `token-usage`
  `billing` `electron` `plugin` `cost-tracker` `observability`
- 点 **Save changes**

### 4.2 上传社交预览图

**Settings → General → 拉到最下面 Social preview → Upload an image** →
选 `docs\social-preview.png`（1280×640，仓库里已带）。
这是别人在 X / HN / Reddit 看到的第一眼，比 README 还重要。

### 4.3 发第一个 Release

1. 仓库首页右侧 **Releases → Create a new release**
2. **Choose a tag** 输入 `v0.4.4` → 点 “Create new tag on publish”
3. **Release title** 填 `v0.4.4 — accurate to 1e-8`
4. 正文：打开 `docs\release-notes-0.4.4.md`，全选复制粘进去
5. 点 **Publish release**

### 4.4（可选）要不要发 npm

**不发也能用**。别人可以从 GitHub 直装：

```bash
dsh plugin --profile <name> add github:lx950/dsh-spend-meter
```

桌面版用户改 profile 的 `package.json`（依赖写 `"dsh-spend-panel": "github:lx950/dsh-spend-meter"`，再往 `dsh.profile.bundles` 里加一行），细节见 README 的 Install 段。

如果以后想让安装更方便（`dsh plugin add dsh-spend-panel` 一行装好、App 插件管理器能搜到、npm 徽章变绿），再发 npm 也不迟：

```bash
cd /e/deepseek/dsh-spend-meter
npm login            # 浏览器登录或输账号密码
npm publish --access public
```

> npm 包名是 `dsh-spend-panel`（`dsh-spend-meter` 已被别人占用）。

---

## 第 5 步：推广（星标真正来自这一步）

复制现成文案：`docs\announcement.md`（Show HN / Reddit / X / V2EX / 掘金各一份）。

顺序和节奏：

1. **Show HN**：周二到周四，北京时间 16:00–18:00（= 08:00–10:00 UTC）
2. **Reddit** 同一天：r/LocalLLaMA + r/DeepSeek
3. **X**：4 条串，第一条配 `docs/social-preview.png`
4. **中文社区**（V2EX / 掘金）第二天上午
5. 前 24 小时**每条评论都回**——这一步比文案重要

---

## 常见问题

| 现象 | 原因 / 解决 |
| --- | --- |
| 推送时弹窗要求密码 | GitHub 不支持账号密码；选 “Sign in with your browser”，不要输密码 |
| `Permission denied (publickey)` | 你在用 SSH 地址；把 remote 换成 `https://...` 即可 |
| 网页上显示的是别人的仓库 | 第 1 步没退登录的其他账号；用无痕窗口重新建 |
| `failed to push some refs` / `rejected` | 建仓时勾了 README 等文件；`git pull --rebase origin main` 再推 |
| 徽章一直不亮 | CI 需要第一次 push 后才跑；去 **Actions** 标签看是否在跑 |
| 不想公开了 | Settings → 最下面 **Danger Zone → Change visibility** |

---

## 一次性核对清单

- [ ] GitHub 账号可用，用户名记下来了
- [ ] 空仓库 `dsh-spend-meter` 已建（Public，没勾任何初始化文件）
- [ ] 7 个文件里的 `github.com/USER` 全部替换完（`grep` 无输出）
- [ ] `git config user.name/user.email` 是自己的
- [ ] `git push -u origin main` 成功，网页能看到 37 个文件
- [ ] About + 11 个 topics 填好
- [ ] Social preview 上传了 `docs/social-preview.png`
- [ ] `v0.4.4` Release 已发布（正文来自 `docs/release-notes-0.4.4.md`）
- [ ] CI 徽章变绿
- [ ] 至少发了一条公告，评论区回满 24 小时
