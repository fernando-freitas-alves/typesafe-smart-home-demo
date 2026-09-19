// The keyboard can shrink AND pan the visual viewport, or scroll an HA parent.
// Keep the whole chat inside the visible area, in the host's coordinate space.
export function chatViewportFrame({ height, offsetTop = 0, hostTop = 0 }) {
  const top = Math.max(hostTop, offsetTop);
  return {
    height: Math.max(0, Math.floor(height + offsetTop - top)),
    shift: Math.max(0, offsetTop - hostTop),
  };
}
