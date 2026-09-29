import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render Better Learning Studio's turning-page mark.
 * @param props - Host-supplied mark presentation.
 * @returns the studio mark.
 */
export function OfficialBrandMark({ size, className }: SidebarBrandMarkOwnerProps & { className?: string | undefined }) {
  return <svg width={size} height={size} className={className} viewBox="0 0 1024 1024" aria-hidden="true">
    <rect width="1024" height="1024" rx="224" fill="#FFFFFF" />
    <g transform="translate(-142 -106) scale(1.8)" fill="#111111">
      <path d="M203 248 374 164C393 155 412 165 412 183V423C380 404 352 418 311 442 268 467 231 504 203 532Z" />
      <path d="M222 533C293 529 355 503 409 468 463 434 504 357 524 278V504C524 539 504 550 470 552 384 551 299 534 222 533Z" />
    </g>
  </svg>
}
