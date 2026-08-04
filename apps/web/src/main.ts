import {
  AppWindow,
  BookOpen,
  CodeXml,
  createIcons,
  Download,
  GlobeLock,
  KeyRound,
  Layers3,
  MonitorSmartphone,
  Music,
  Network,
  RadioTower,
  Route,
  SquareTerminal,
  UserRoundX,
  Waypoints,
} from "lucide";

createIcons({
  icons: {
    AppWindow,
    BookOpen,
    CodeXml,
    Download,
    GlobeLock,
    KeyRound,
    Layers3,
    MonitorSmartphone,
    Music,
    Network,
    RadioTower,
    Route,
    SquareTerminal,
    UserRoundX,
    Waypoints,
  },
});

const sectionLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-section-link]"));
const pageSections = Array.from(document.querySelectorAll<HTMLElement>("[data-section]"));

if ("IntersectionObserver" in window && sectionLinks.length > 0 && pageSections.length > 0) {
  const observer = new IntersectionObserver(
    (entries) => {
      const activeEntry = entries.find((entry) => entry.isIntersecting);
      if (!activeEntry) return;

      for (const link of sectionLinks) {
        const isCurrent = link.dataset.sectionLink === activeEntry.target.id;
        link.classList.toggle("is-current", isCurrent);
        if (isCurrent) {
          link.setAttribute("aria-current", "location");
        } else {
          link.removeAttribute("aria-current");
        }
      }
    },
    { rootMargin: "-72px 0px -75%", threshold: 0 },
  );

  for (const section of pageSections) observer.observe(section);
}
