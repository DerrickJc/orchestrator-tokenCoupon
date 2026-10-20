const tabs = [
  { id: "overview", label: "概览" },
  { id: "draft", label: "草案" },
  { id: "review", label: "审查与批准" },
  { id: "execution", label: "执行与结果" },
] as const;

export function PlanTabs({ selectedTab, onSelect }: { selectedTab: string; onSelect(tab: string): void }) {
  const selected = ["models", "attempts"].includes(selectedTab) ? "execution" : selectedTab;
  return (
    <nav id="plan-tabs" className="plan-tabs" aria-label="计划页面">
      {tabs.map(tab => (
        <button
          type="button"
          key={tab.id}
          data-plan-tab={tab.id}
          className={selected === tab.id ? "active" : ""}
          aria-current={selected === tab.id ? "page" : "false"}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
