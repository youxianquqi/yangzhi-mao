#!/bin/sh

pause_on_failure() {
    if [ -t 0 ] && [ "${WRITE_NO_PAUSE:-}" != 1 ]; then
        printf '按回车键退出…'
        IFS= read -r ignored
    fi
}

if ! CDPATH= cd -P "$(dirname "$0")"; then
    printf '%s\n' '无法进入 Write 目录，请先完整解压项目。' >&2
    pause_on_failure
    exit 1
fi

node_22() {
    "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' >/dev/null 2>&1
}

if [ -x ./runtime/bin/node ] && node_22 ./runtime/bin/node; then
    node_bin=./runtime/bin/node
elif node_22 node; then
    node_bin=node
else
    printf '%s\n' '需要 Node.js 22 或更新版本。请下载并安装：https://nodejs.org/zh-cn/download' \
        '安装后重新启动 Write。也可以下载预装 Node.js 的 Write 便携版。' >&2
    pause_on_failure
    exit 1
fi

"$node_bin" scripts/start-local.mjs "$@"
status=$?
if [ "$status" -ne 0 ]; then
    pause_on_failure
fi
exit "$status"
