import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryBackupExportPanel, MemoryBackupImportPanel } from "./MemoryBackupPanels";

describe("memory backup panels", () => {
  it("offers one restorable backup format with source export consent", () => {
    const markup = renderToStaticMarkup(<MemoryBackupExportPanel includeSources busy={false} onIncludeSources={vi.fn()} onExport={vi.fn()} />);
    expect(markup).toContain(".zmlmem");
    expect(markup).toContain("确认将其写入所选文件");
    expect(markup).not.toMatch(/Markdown|JSON/);
  });

  it("shows verified contents, the current target, and merge semantics before confirmation", () => {
    const markup = renderToStaticMarkup(<MemoryBackupImportPanel
      inspection={{ token: "opaque", fileName: "backup.zmlmem", petName: "原桌宠", exportedAt: "2026-11-07T01:00:00Z", recordCount: 12, sourceCount: 3 }}
      petName="当前桌宠" busy={false} onClose={vi.fn()} onConfirm={vi.fn()} onSelect={vi.fn()} />);
    expect(markup).toContain("完整性与格式版本校验通过");
    expect(markup).toContain("12 条记忆、3 轮来源对话");
    expect(markup).toContain("当前桌宠");
    expect(markup).toContain("不覆盖现有记忆");
    expect(markup).toContain("确认恢复");
    expect(markup).not.toContain("opaque");
  });

  it("provides reselection without a restore action when validation fails", () => {
    const markup = renderToStaticMarkup(<MemoryBackupImportPanel petName="当前桌宠" busy={false} error="完整性校验失败" onClose={vi.fn()} onConfirm={vi.fn()} onSelect={vi.fn()} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("重新选择文件");
    expect(markup).not.toContain("确认恢复");
  });
});
