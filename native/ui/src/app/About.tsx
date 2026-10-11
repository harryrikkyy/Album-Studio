// About.tsx — Album Studio's About box: what it is, what it's built on (in plain words, as
// PhotoCraft's brand licence asks of works based on it), and the licences that come with it.

import { signal } from '@preact/signals'
import { BookImage, X } from 'lucide-preact'
import { useEffect, useRef } from 'preact/hooks'
import { IconButton } from '../ui/controls'

const open = signal(false)
export const openAbout = () => { open.value = true }

export function AboutDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open.value && !d.open) d.showModal()
    else if (!open.value && d.open) d.close()
  }, [open.value])
  return (
    <dialog class="dialog about" ref={ref} onClose={() => (open.value = false)} aria-labelledby="about-title">
      <div class="dialog__body">
        <div class="dialog__titlebar">
          <h2 id="about-title" class="dialog__title"><BookImage size={18} /> Album Studio</h2>
          <IconButton label="Close" onClick={() => (open.value = false)}><X size={16} /></IconButton>
        </div>
        <p class="dialog__lead">Plans, builds and delivers wedding albums: from the shoot’s folders to print sheets, the lab’s JPEGs and the client’s PDF, on this Mac, without Photoshop.</p>
        <section class="about__credits">
          <h3>Built with</h3>
          <ul>
            <li><b>The editor and the sheet renderer</b> are based on PhotoCraft by the ArtCraft team and the PhotoCraft contributors, used under the MIT or Apache 2.0 licence.</li>
            <li><b>Image processing</b>: sharp (Apache 2.0) and libvips (LGPL 2.1 or later). <b>PSD reading</b>: ag-psd (MIT).</li>
            <li><b>Interface</b>: Preact (MIT), Lucide icons (ISC). <b>Window</b>: wry (MIT or Apache 2.0).</li>
          </ul>
          <p class="muted">The full licence texts and notices ship with Album Studio in its NOTICE file.</p>
        </section>
      </div>
    </dialog>
  )
}
