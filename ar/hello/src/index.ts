/**
 * AR source-migration spike: registers the `/ar-hello` human command so a UI
 * session can prove an out-of-tree `@knevo/*` plugin row is mounted. No model
 * work, no session events beyond the command lifecycle pair.
 * @module @knevo/dsh-ar-hello
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'ar-hello'
export const inject = ['commands']

/** Register the global `/ar-hello` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'ar-hello',
    description: 'AR migration spike: confirm the @knevo plugin layer is mounted',
    handler: (): CommandResult => ({
      kind: 'success',
      text: 'AR plugin layer mounted: hello from @knevo/dsh-ar-hello.',
    }),
  })
}
