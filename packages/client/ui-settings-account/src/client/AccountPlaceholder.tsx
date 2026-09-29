/** Better Learning Studio's future account entry in Desktop Settings. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Static account page; the API workflow remains available without sign-in. */
export function AccountPlaceholder({ t }: PropsRuntime<'settings.section'> & PropsLocale<'settings.account'>) {
  return <section style={{ padding: '28px 32px', maxWidth: 640 }}>
    <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 600 }}>{t('placeholderTitle')}</h2>
    <p style={{ margin: 0, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' }}>{t('placeholderDescription')}</p>
  </section>
}
