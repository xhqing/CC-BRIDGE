# cc-bridge 运行版本安装规则

## 核心原则

cc-bridge 的运行版本**必须统一从 GitHub Release 的 tgz 全局安装**（`npm install -g <下载的tgz>`），**禁止**用 `npm link` 把项目开发目录链接为全局命令。

**原因**：`/Users/xhq/Documents/Projects/CC-BRIDGE` 是开发目录，文件随开发随时变化。`npm link` 会让全局 `cc-bridge` 命令和 daemon 进程都指向开发源码，运行版本不可控——开发改动会实时污染线上桥接。运行环境必须与开发目录解耦：daemon 应运行安装副本 `/opt/homebrew/lib/node_modules/cc-bridge/core/server.js`，而非项目源码 `.../Projects/CC-BRIDGE/core/server.js`。

## 安装/升级流程

1. 下载 Release tgz（仓库 `xhqing/CC-BRIDGE` 为 **private**，`curl` 匿名下载返回 404，必须用带认证的 `gh`）：
   ```
   gh release download <tag> --pattern 'cc-bridge-<ver>.tgz' --dir /tmp --clobber
   ```
2. 全局安装：`npm install -g /tmp/cc-bridge-<ver>.tgz`
3. 重启 daemon 使其从安装副本启动：`cc-bridge restart`（默认上游 glm；显式写 `cc-bridge glm restart`）。
4. 验证：daemon 进程路径是安装副本（非项目源码）；`npm list -g cc-bridge` 无 `-> 项目目录` 箭头。

## 发新版本流程

1. 同步 bump 版本号：`VERSION` + `package.json` + `CHANGELOG` 三处。
2. `npm pack` 生成 tgz；清理旧版本 tgz。
3. `git commit` + `git tag v<x.y.z>` + `git push`（main 与 tag）。
4. `gh release create v<x.y.z> --notes-file <notes> --latest` + `gh release upload v<x.y.z> <pkg>.tgz`。
5. 再按「安装/升级流程」从 Release 装到本机，并重启 daemon。

## 自检

- `npm list -g cc-bridge` 出现 `-> .../Projects/CC-BRIDGE` 箭头，即为错误的 link 状态，须按上面流程重装为正式安装。
- 查版本：`cc-bridge --version`（从 `package.json` 读取）。
