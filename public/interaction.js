(() => {
  const pending = new Map();

  document.addEventListener("submit", event => {
    const form = event.target.closest("form[data-submit-pending]");
    if (!form || event.defaultPrevented) return;
    if (pending.has(form)) {
      event.preventDefault();
      return;
    }

    const button = event.submitter ?? form.querySelector('button[type="submit"]');
    if (!button) return;
    pending.set(form, { button, label: button.textContent, width: button.style.minWidth });
    button.style.minWidth = `${Math.ceil(button.getBoundingClientRect().width)}px`;
    button.textContent = form.dataset.submitPending;
    button.setAttribute("aria-disabled", "true");
    form.setAttribute("aria-busy", "true");
  });

  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest(".ws-nav-links a[href]");
    if (!link || link.origin !== location.origin || link.pathname === location.pathname && link.search === location.search) return;
    document.querySelector(".ws-nav-links [data-navigating]")?.removeAttribute("data-navigating");
    link.setAttribute("data-navigating", "");
    document.documentElement.setAttribute("data-navigating", "");
  });

  window.addEventListener("pageshow", () => {
    for (const [form, { button, label, width }] of pending) {
      button.textContent = label;
      button.style.minWidth = width;
      button.removeAttribute("aria-disabled");
      form.removeAttribute("aria-busy");
    }
    pending.clear();
    document.querySelector(".ws-nav-links [data-navigating]")?.removeAttribute("data-navigating");
    document.documentElement.removeAttribute("data-navigating");
  });
})();
