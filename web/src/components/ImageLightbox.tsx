import { useEffect } from "react";
import type { ImageOverlay } from "../../../server/src/domain.ts";
import { ImageOverlayLayer } from "./ImageOverlaySvg.tsx";

// One image-anchored thread's overlay contribution, keyed by its comment id.
export interface LightboxOverlay {
  id: string;
  overlay: ImageOverlay;
}

interface ImageLightboxProps {
  assetId: string;
  // every image-anchored root comment's overlay for this asset, stacked —
  // the board image shows one at a time on hover; review shows the full
  // picture
  overlays: LightboxOverlay[];
  canAnnotate: boolean;
  onAnnotate(): void;
  onClose(): void;
}

// The image lightbox (dogfooded ask [163]): full-size review of one asset
// with every image-anchored overlay for it stacked (each thread contributes
// its own layer — the shared renderer, no fork). Extracted from BoardView so
// work landing beside the version switcher composes the modal instead of
// growing BoardView; the modal knows nothing about boards or comments —
// props in, callbacks out.
export function ImageLightbox({
  assetId,
  overlays,
  canAnnotate,
  onAnnotate,
  onClose,
}: ImageLightboxProps) {
  // Escape closes (the keyboard path alongside the close button). The
  // component is mounted only while the modal is open, so the listener's
  // lifetime IS the modal's. No focus trap for v1: the modal is read-only
  // review with two real buttons — a trap is overkill and this modal never
  // stacks.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a pointer-only extra — Escape and the close button close for keyboard users
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <div
      className="modal-backdrop lightbox-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal lightbox" role="dialog" aria-label="image preview">
        <div className="lightbox-toolbar">
          <span className="lightbox-title">{assetId}</span>
          {canAnnotate && (
            <button type="button" className="pill" onClick={onAnnotate}>
              annotate
            </button>
          )}
          <button type="button" className="pill active" onClick={onClose}>
            close
          </button>
        </div>
        {/* hugs the img like the editor's stage, so the overlay layers
            measure exactly the displayed image box */}
        <div className="lightbox-stage">
          <img src={`/assets/${assetId}`} alt="" draggable={false} />
          {overlays.map(({ id, overlay }) => (
            <ImageOverlayLayer key={id} overlay={overlay} />
          ))}
        </div>
      </div>
    </div>
  );
}
