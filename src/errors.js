// Owns public error codes, status and safe default messages across layers.
// Causes are available to callers but must not enter HTTP responses or logs.
import { LIMITS } from './config.js';

/** @satisfies {Record<string, readonly [number, string]>} */
const ERRORS = {
    INVALID_INPUT: [400, '输入无效。'],
    INVALID_JSON: [400, '请求中的 JSON 无效。'],
    LOCAL_ONLY: [403, '此应用只接受来自本机页面的请求。'],
    THREAD_NOT_FOUND: [404, '找不到这条剧情线。'],
    MESSAGE_NOT_FOUND: [404, '找不到这条消息。'],
    CHARACTER_NOT_FOUND: [404, '找不到这个角色。'],
    ROUTE_NOT_FOUND: [404, '接口不存在。'],
    CHARACTER_BUSY: [409, '这条剧情线或角色还有请求在处理，请稍等。'],
    THREAD_CHANGED: [409, '聊天记录已更新，请刷新后再操作。'],
    LAST_THREAD: [409, '至少保留一条剧情线。'],
    THREAD_LIMIT: [409, '已达到该角色的剧情线数量上限。'],
    THREADS_UNAVAILABLE: [409, '当前存储服务不支持新增剧情线。'],
    REGENERATE_UNAVAILABLE: [409, '最后一条消息不是可重抽的回复。'],
    AGENT_INVALID_SESSION: [409, '存档中的 Agent 会话 ID 无效，请新开会话。'],
    AGENT_SESSION_NOT_FOUND: [409, 'Agent 找不到旧会话，请新开会话。'],
    PAYLOAD_TOO_LARGE: [413, '请求内容太长。'],
    UNSUPPORTED_MEDIA_TYPE: [415, '请求必须使用 JSON，且字符集和编码须受支持。'],
    AGENT_RATE_LIMITED: [429, 'Agent 达到使用限额，请稍后再试。'],
    STREAM_ABORTED: [499, '已停止生成，未完成的回复不会写入存档。'],
    INTERNAL_ERROR: [500, '本地服务出错，请查看启动终端。'],
    STORAGE_ERROR: [500, '无法操作本地存档或锁，请检查数据目录。'],
    AGENT_INVALID_RESULT: [502, 'Agent 未返回完整回复或返回了不同的会话。'],
    AGENT_SESSION_MISMATCH: [502, 'Agent 返回了不同的会话 ID，未保存这轮消息。'],
    AGENT_OUTPUT_TOO_LARGE: [502, 'Agent 输出过长，未保存这轮消息。'],
    AGENT_REPLY_TOO_LONG: [502, 'Agent 回复超过 ' + LIMITS.replyLength + ' 个字符，未保存这轮消息。'],
    AGENT_UNAVAILABLE: [502, 'Agent 连接失败，请检查网络后重试。'],
    AGENT_INCOMPLETE: [502, 'Agent 未返回完整回复，请检查当前 Agent。'],
    AGENT_PROTOCOL: [502, 'Agent 返回了无法解析的协议数据，未保存这轮消息。'],
    CODEX_NOT_FOUND: [503, '找不到 Codex CLI。请安装后运行 codex login。'],
    CODEX_START_FAILED: [503, '无法启动 Codex CLI，请检查可执行路径和系统权限。'],
    CODEX_AUTH_REQUIRED: [503, 'Codex 拒绝了当前登录。请检查 codex login status，必要时重新登录。'],
    AGENT_TIMEOUT: [504, '等待 Agent 回复超时，请重试。'],
};

/** @typedef {keyof typeof ERRORS} ErrorCode */

/** HTTP-safe application failure; construct via appError to keep defaults centralized. */
export class AppError extends Error {
    /** @param {number} status @param {string} code @param {string} message @param {ErrorOptions} [options] */
    constructor(status, code, message, options) {
        super(message, options);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
    }
}

/**
 * @param {keyof typeof ERRORS} code Public machine-readable error code.
 * @param {{cause?: unknown, message?: string}} [options] Optional private cause and safe display text.
 * @returns {AppError}
 */
export function appError(code, { cause, message } = {}) {
    const [status, defaultMessage] = ERRORS[code];
    return new AppError(status, code, message ?? defaultMessage, { cause });
}
