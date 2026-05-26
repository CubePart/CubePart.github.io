// Interactive-gallery carousel (scroll-snap + prev/next + dots).
function initCarousels() {
  document.querySelectorAll('.pv-carousel').forEach((root) => {
    const track = root.querySelector('.pv-track');
    const prev = root.querySelector('.pv-prev');
    const next = root.querySelector('.pv-next');
    const dotsHost = root.querySelector('.pv-dots');
    if (!track) return;

    const cards = Array.from(track.children);
    if (cards.length === 0) return;

    // Build dots
    if (dotsHost) {
      dotsHost.innerHTML = '';
      cards.forEach((_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pv-dot' + (i === 0 ? ' active' : '');
        b.setAttribute('aria-label', `Go to example ${i + 1}`);
        b.addEventListener('click', () => scrollToIndex(i));
        dotsHost.appendChild(b);
      });
    }

    const cardWidth = () => track.clientWidth; /* each card is 100% wide */
    const currentIndex = () => Math.round(track.scrollLeft / cardWidth());
    const wrap = (i) => ((i % cards.length) + cards.length) % cards.length;

    function scrollToIndex(i, opts = {}) {
      const idx = wrap(i);
      // If the request wrapped around either end, snap instantly so the user
      // doesn't see the carousel rewind through every card. We have to clear
      // the CSS `scroll-behavior: smooth` on the track for one frame because
      // it overrides `behavior: 'auto'` in scrollTo().
      const wrapping = i !== idx;
      if (wrapping || opts.instant) {
        const prevBehavior = track.style.scrollBehavior;
        track.style.scrollBehavior = 'auto';
        track.scrollLeft = idx * cardWidth();
        // Restore on the next frame so subsequent smooth scrolls work again.
        requestAnimationFrame(() => { track.style.scrollBehavior = prevBehavior; });
      } else {
        track.scrollTo({ left: idx * cardWidth(), behavior: 'smooth' });
      }
    }

    function updateUI() {
      const idx = currentIndex();
      // Prev/next are always enabled — the carousel loops.
      if (prev) prev.disabled = false;
      if (next) next.disabled = false;
      if (dotsHost) {
        dotsHost.querySelectorAll('.pv-dot').forEach((d, i) => {
          d.classList.toggle('active', i === idx);
        });
      }
    }

    prev?.addEventListener('click', () => scrollToIndex(currentIndex() - 1));
    next?.addEventListener('click', () => scrollToIndex(currentIndex() + 1));

    let rafId = null;
    track.addEventListener('scroll', () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateUI);
    });

    // Keyboard navigation when focus is inside the carousel
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { scrollToIndex(currentIndex() - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { scrollToIndex(currentIndex() + 1); e.preventDefault(); }
    });
    root.tabIndex = 0;

    // Re-center on the current card when the container resizes (avoids drift).
    let lastWidth = cardWidth();
    const ro = new ResizeObserver(() => {
      const w = cardWidth();
      if (w !== lastWidth) {
        const idx = Math.round(track.scrollLeft / lastWidth);
        track.scrollLeft = idx * w;
        lastWidth = w;
        updateUI();
      }
    });
    ro.observe(track);

    updateUI();
  });
}

// Pause gallery videos when the carousel card they live in is scrolled off.
// IMPORTANT: We use the carousel TRACK as the IntersectionObserver root,
// because every card geometrically overlaps the viewport at the same time
// (only the track's overflow:hidden clips them).  Without setting root, the
// observer would never report an off-screen carousel card.
function initLazyVideos() {
  const videos = document.querySelectorAll('.pv-video video');
  videos.forEach((v) => {
    // Best-effort kick (covers Safari's autoplay-after-mute-attr quirk).
    const tryPlay = () => v.play?.().catch(() => {});
    if (v.readyState >= 2) tryPlay(); else v.addEventListener('canplay', tryPlay, { once: true });

    if (!('IntersectionObserver' in window)) return;
    const root = v.closest('.pv-track') || null;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) tryPlay();
      else v.pause?.();
    }, { root, threshold: 0.4 });
    io.observe(v);
  });
}

// Copy-to-clipboard for BibTeX
document.addEventListener('DOMContentLoaded', () => {
  initCarousels();
  initLazyVideos();
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.target;
      const target = document.getElementById(targetId);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.innerText);
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove('copied');
        }, 1500);
      } catch (e) {
        const range = document.createRange();
        range.selectNode(target);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  });
});
