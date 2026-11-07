import { CircleAlert, Download, ShieldCheck } from "lucide-react";
import type { MemoryBackupInspection } from "../../../shared/types/memoryBackup";
import { formatMemoryDateTime } from "./memoryBookState";

export function MemoryBackupExportPanel({ includeSources, busy, error, onIncludeSources, onExport }: {
  includeSources: boolean;
  busy: boolean;
  error?: string;
  onIncludeSources: (value: boolean) => void;
  onExport: () => void;
}): JSX.Element {
  return <div className="memoryExportPanel">
    <p>保存为 .zmlmem 记忆备份，可在记忆书中导入恢复。包含全部有效记忆、分类、标签和时间。</p>
    <label className="memoryCheckRow"><input type="checkbox" disabled={busy} checked={includeSources} onChange={(event) => onIncludeSources(event.target.checked)} />包含已保留的来源对话</label>
    {includeSources ? <div className="memoryConsentNotice"><CircleAlert size={18} />来源对话可能含敏感内容。继续导出表示你确认将其写入所选文件。</div> : null}
    {error ? <div className="memoryInlineError" role="alert"><CircleAlert size={20} /><span>{error}</span></div> : null}
    <div className="memoryDialogActions"><button className="primaryAction" disabled={busy} type="button" onClick={onExport}><Download size={18} />{busy ? "正在导出…" : "导出备份"}</button></div>
  </div>;
}

export function MemoryBackupImportPanel({ inspection, petName, busy, error, onClose, onConfirm, onSelect }: {
  inspection?: MemoryBackupInspection;
  petName: string;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void;
  onSelect: () => void;
}): JSX.Element {
  return <div className="memoryExportPanel">
    {inspection ? <>
      <p className="memoryBackupVerified"><ShieldCheck size={20} />完整性与格式版本校验通过</p>
      <dl className="memoryBackupDetails">
        <div><dt>备份文件</dt><dd>{inspection.fileName}</dd></div>
        <div><dt>原桌宠</dt><dd>{inspection.petName}</dd></div>
        <div><dt>备份时间</dt><dd>{formatMemoryDateTime(inspection.exportedAt)}</dd></div>
        <div><dt>备份内容</dt><dd>{inspection.recordCount} 条记忆、{inspection.sourceCount} 轮来源对话</dd></div>
      </dl>
      <p>将合并恢复到 <strong>{petName}</strong> 的记忆书。已有记录保留，重复记录跳过，不覆盖现有记忆。</p>
      {inspection.sourceCount > 0 ? <p>确认恢复也会保存包内的来源对话；开启对话召回后，相关原文可能随记忆发送给当前配置的 AI。</p> : null}
    </> : null}
    {error ? <div className="memoryInlineError" role="alert"><CircleAlert size={20} /><span>{error}</span></div> : null}
    <div className="memoryDialogActions">
      <button className="secondaryAction" disabled={busy} type="button" onClick={onClose}>取消</button>
      {inspection ? <button className="primaryAction" disabled={busy} type="button" onClick={onConfirm}>{busy ? "正在恢复…" : "确认恢复"}</button>
        : <button className="primaryAction" disabled={busy} type="button" onClick={onSelect}>{busy ? "正在校验…" : "重新选择文件"}</button>}
    </div>
  </div>;
}
