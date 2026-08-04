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

import { findActiveSectionId } from "./navigation";

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
const siteHeader = document.querySelector<HTMLElement>(".site-header");

if ("IntersectionObserver" in window && sectionLinks.length > 0 && pageSections.length > 0) {
  const updateCurrentSection = () => {
    const activeSectionId = findActiveSectionId(
      pageSections.map((section) => ({
        id: section.id,
        top: section.getBoundingClientRect().top,
      })),
      siteHeader?.offsetHeight ?? 80,
    );

    for (const link of sectionLinks) {
      const isCurrent = link.dataset.sectionLink === activeSectionId;
      link.classList.toggle("is-current", isCurrent);
      if (isCurrent) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  };

  const observer = new IntersectionObserver(updateCurrentSection, {
    rootMargin: "-72px 0px -75%",
    threshold: 0,
  });

  for (const section of pageSections) observer.observe(section);
}
