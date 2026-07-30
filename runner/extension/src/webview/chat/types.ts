export interface SessionSummary {
    session_id: string;
    title: string;
    updated_at: number; // unix seconds (file mtime)
}

export interface ToolPermission {
    enabled: boolean;
    require_permission: boolean;
}

export interface ThinkingConfig {
    enabled: boolean;
    budget_tokens?: number;       // Anthropic only
    reasoning_effort?: string;    // 'low' | 'medium' | 'high' for OpenAI/Gemini; 'high' | 'max' for DeepSeek
}

export interface SubAgentsConfig {
    enabled: boolean;
    max_steps: number;
}

export interface AgentYamlSnapshot {
    provider: string;
    model: string;
    temperature: number;
    max_tokens: number;
    api_key_env: string;
    max_steps: number;
    unsafe_mode: boolean;
    system_prompt: string;
    tools: Record<string, ToolPermission>;
    thinking?: ThinkingConfig;
    sub_agents?: SubAgentsConfig;
}

export interface UpdateSettingsPayload {
    provider: string;
    model: string;
    temperature: number;
    max_tokens: number;
    api_key_env: string;
    api_key?: string; // only present when the user typed a new one
    max_steps: number;
    unsafe_mode: boolean;
    tools: Record<string, ToolPermission>;
    system_prompt_append?: string;
    thinking?: ThinkingConfig;
    sub_agents?: SubAgentsConfig;
}

export const MODELS_BY_PROVIDER: Record<string, string[]> = {
    anthropic: ['claude-opus-4-8', 'claude-sonnet-5'],
    openai:    ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    alibaba:   ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.5-flash'],
    deepseek:  ['deepseek-v4-pro', 'deepseek-v4-flash'],
};

/** Default max_tokens per model as confirmed by provider docs. */
export const MAX_TOKENS_BY_MODEL: Record<string, number> = {
    // Anthropic
    'claude-opus-4-8':   128000,
    'claude-sonnet-5':   128000,
    // OpenAI
    'gpt-5.5':           128000,
    'gpt-5.6-sol':       128000,
    'gpt-5.6-terra':     128000,
    'gpt-5.6-luna':      128000,
    // Alibaba
    'qwen3.7-max':        65536,
    'qwen3.7-plus':       65536,
    'qwen3.5-flash':      65536,
    // DeepSeek
    'deepseek-v4-pro':   384000,
    'deepseek-v4-flash': 384000,
};

// codepilot-ai reads the key from an env var named per-provider.
export const PROVIDER_ENV_VAR: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai:    'OPENAI_API_KEY',
    alibaba:   'DASHSCOPE_API_KEY',
    deepseek:  'DEEPSEEK_API_KEY',
};

export const APPEND_PROMPT_MAX_LEN = 2000;