import { IStore } from './store'
import { BotConfig, ChatMessage } from './types'
import { ILLMClient } from './deepseek'
import { Logger } from './logger'

interface ConversationState {
  history: ChatMessage[]
  summary?: string
  persona?: string
}

export class ConversationManager {
  private sessions = new Map<string, ConversationState>()

  constructor(private config: BotConfig, private deepseek: ILLMClient, private store: IStore, private logger: Logger) {}

  get activeSessions() {
    return this.sessions.size
  }

  reset(sessionKey: string) {
    this.sessions.delete(sessionKey)
  }

  setPersona(sessionKey: string, persona: string | undefined) {
    const state = this.sessions.get(sessionKey) ?? { history: [] }
    state.persona = persona
    this.sessions.set(sessionKey, state)
  }

  getPersona(sessionKey: string) {
    return this.sessions.get(sessionKey)?.persona
  }

  async reply(sessionKey: string, userText: string): Promise<string> {
    const state = this.sessions.get(sessionKey) ?? { history: [] }

    state.history.push({ role: 'user', content: userText })

    if (state.history.length > this.config.summaryTrigger) {
      await this.summarize(state)
    }

    const messages: ChatMessage[] = [{ role: 'system', content: this.config.deepseek.systemPrompt }]

    if (state.persona && this.config.personaPresets[state.persona]) {
      messages.push({ role: 'system', content: this.config.personaPresets[state.persona] })
    }

    if (state.summary) {
      messages.push({ role: 'system', content: `对话摘要：${state.summary}` })
    }

    const recent = state.history.slice(-this.config.maxContextMessages)
    messages.push(...recent)

    const result = await this.deepseek.chat(messages)

    state.history.push({ role: 'assistant', content: result.text })
    if (state.history.length > this.config.maxContextMessages * 2) {
      state.history = state.history.slice(-this.config.maxContextMessages)
    }

    this.sessions.set(sessionKey, state)

    if (result.usage) {
      await this.store.recordUsage(result.usage)
    }

    return result.text
  }

  private async summarize(state: ConversationState) {
    const serialized = state.history
      .slice(-this.config.summaryTrigger)
      .map((item) => `${item.role}: ${item.content}`)
      .join('\n')

    const summaryMessages: ChatMessage[] = [
      { role: 'system', content: '请用中文总结以下对话，保留关键事实、指令与上下文，不超过200字。' },
      { role: 'user', content: serialized },
    ]

    try {
      const summary = await this.deepseek.chat(summaryMessages, {
        maxTokens: this.config.deepseek.summaryMaxTokens,
        temperature: 0.2,
      })
      if (summary.usage) {
        await this.store.recordUsage(summary.usage)
      }
      state.summary = summary.text
      state.history = state.history.slice(-Math.floor(this.config.maxContextMessages / 2))
    } catch (err) {
      this.logger.warn('生成摘要失败，将跳过：%s', err)
    }
  }
}
