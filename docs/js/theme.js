// Light / dark toggle shared by both pages. Falls back to the OS setting; the choice is remembered if storage works.
(function () {
  const root = document.documentElement;
  try { const saved = localStorage.getItem("theme"); if (saved) root.setAttribute("data-theme", saved); } catch (e) { /* ignore */ }
  const btn = document.getElementById("theme");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const cur = root.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
  });
})();
