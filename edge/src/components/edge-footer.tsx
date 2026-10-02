import { Download, ExternalLink } from "lucide-react";

// Shown on every viewport: AGPL requires the source to stay reachable for network users.
export function EdgeFooter() {
  return (
    <footer className="es-foot">
      <div className="es-foot-in">
        <p>EdgeSub · 基于 SubBoost 2.6.0 · AGPL-3.0-only</p>
        <div className="es-foot-links">
          <a href="/subboost-edge-source.tar.gz" download>
            对应源代码
            <Download className="h-3 w-3" />
          </a>
          <a href="https://github.com/SubBoost/subboost" target="_blank" rel="noopener noreferrer">
            上游项目
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </footer>
  );
}
