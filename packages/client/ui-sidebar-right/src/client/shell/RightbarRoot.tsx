/** Root-scoped right Sidebar content for Sessions and global main panels. */
import { useLayoutEffect } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SidebarSessionViewSnapshot } from '../session-views.ts'
import type {} from '../contract/slots.ts'
import css from './SidebarRight.module.css'

/** Root-only retained Session targets and their committed mount lifetimes. */
export interface RightbarRootInjected {
  readonly hooks: { readonly views: HostObservable<readonly SidebarSessionViewSnapshot[]> }
  readonly mountView: (reference: SessionReference) => () => void
}

type RootProps = PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session' | 'rightbar.panel'> & InjectFace<RightbarRootInjected>

function SessionView({ view, visible, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }:
  Pick<RootProps, 'SessionProvider' | 'renderSlot' | 'mountView' | 'width' | 'viewportWidth' | 'canShow'>
  & { readonly view: SidebarSessionViewSnapshot; readonly visible: boolean }) {
  useLayoutEffect(() => mountView(view.reference), [mountView, view.reference])
  const active = visible && view.selected
  return <div className={css.session} hidden={!active} data-sidebar-right-session={view.sessionId}>
    <SessionProvider session={view.reference}>
      {renderSlot('rightbar.session', { width, viewportWidth, canShow, active, retainTab: view.retainTab })}
    </SessionProvider>
  </div>
}

/**
 * Retain Session subtrees while a global panel supplies its independent right column.
 * @param props - frame geometry, retained views, and authorized content renderers.
 * @returns Session Sidebars and the selected global panel's optional root content.
 */
export function RightbarRoot({ usePanelInfo, useViews, ...props }: RootProps) {
  const panelId = usePanelInfo(info => info.activePanelId)
  const views = useViews(value => value)
  return <>
    {views.map(view => <SessionView key={view.sessionId} {...props} view={view} visible={panelId === null} />)}
    {panelId !== null && props.renderSlot('rightbar.panel', {
      width: props.width, viewportWidth: props.viewportWidth, canShow: props.canShow,
    }, { entryKey: panelId })}
  </>
}
