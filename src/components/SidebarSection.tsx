import type { ReactNode } from "react";

interface SidebarSectionProps {
  title: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  actions?: ReactNode;
  children: ReactNode;
}

function SidebarSection({ title, collapsed, onToggleCollapsed, actions, children }: SidebarSectionProps) {
  return (
    <div className={`sidebar-section${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-section-header" onClick={onToggleCollapsed}>
        <span className="sidebar-chevron">▾</span>
        <span className="sidebar-section-title">{title}</span>
        {actions && (
          <div className="sidebar-section-actions" onClick={(event) => event.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      {!collapsed && <div className="sidebar-section-body">{children}</div>}
    </div>
  );
}

export default SidebarSection;
