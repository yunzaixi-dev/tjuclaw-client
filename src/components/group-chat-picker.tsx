import { useState } from 'react';
import {
  Check,
  MessageSquare,
  Users,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import { PRESET_BOT_TEMPLATES } from './bot-creator';
import '../retro-pixel.css';

export interface GroupChatSession {
  id: string;
  name: string;
  botIds: string[];
  lastMessage?: string;
  createdAt: string;
}

interface GroupChatPickerProps {
  onCreatedGroup?: (session: GroupChatSession) => void;
  onCancel?: () => void;
}

export function GroupChatPicker({ onCreatedGroup, onCancel }: GroupChatPickerProps) {
  const [selectedBotIds, setSelectedBotIds] = useState<string[]>(['chief-of-staff', 'signal-monitor']);
  const [groupName, setGroupName] = useState('');

  function toggleBot(id: string) {
    if (selectedBotIds.includes(id)) {
      setSelectedBotIds(selectedBotIds.filter(b => b !== id));
    } else {
      setSelectedBotIds([...selectedBotIds, id]);
    }
  }

  function removeBot(id: string) {
    setSelectedBotIds(selectedBotIds.filter(b => b !== id));
  }

  function handleCreate() {
    if (selectedBotIds.length < 2) return;
    const selectedBots = PRESET_BOT_TEMPLATES.filter(b => selectedBotIds.includes(b.id));
    const defaultName = groupName.trim() || selectedBots.map(b => b.name).join(' & ');
    const session: GroupChatSession = {
      id: `group-${Date.now()}`,
      name: defaultName,
      botIds: selectedBotIds,
      lastMessage: '群聊已建立，多智能体协同就绪。',
      createdAt: new Date().toISOString(),
    };
    onCreatedGroup?.(session);
  }

  const selectedBots = PRESET_BOT_TEMPLATES.filter(b => selectedBotIds.includes(b.id));

  return (
    <div className="pixel-card p-4 space-y-4 font-mono text-xs">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-primary" />
          <h3 className="font-bold text-foreground text-sm">
            发起多智能体协同群聊 (Multi-Bot Group)
          </h3>
        </div>
        <span className="pixel-badge pixel-badge-cyan">
          {selectedBotIds.length} 位协作成员
        </span>
      </div>

      {/* Recipient Tag Tray ("To:") */}
      <div className="bg-muted/40 border border-border rounded-md p-2 flex flex-wrap items-center gap-2 min-h-[44px]">
        <span className="text-muted-foreground font-bold pl-1">收件方 (To):</span>
        {selectedBots.map(b => (
          <span
            key={b.id}
            className="inline-flex items-center gap-1.5 bg-surface border border-border px-2 py-1 rounded text-foreground text-[11px] shadow-sm"
          >
            <span
              className="w-4 h-4 rounded text-[9px] flex items-center justify-center font-bold"
              style={{ backgroundColor: b.avatarBg, color: b.avatarFg }}
            >
              {b.avatarSeed}
            </span>
            <span>{b.name}</span>
            <button
              type="button"
              onClick={() => removeBot(b.id)}
              className="hover:text-destructive p-0.5"
              aria-label={`移除 ${b.name}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {selectedBots.length === 0 && (
          <span className="text-muted-foreground italic text-[11px]">
            请在下方列表中勾选至少 2 位智能体成员...
          </span>
        )}
      </div>

      {/* Optional Group Title */}
      <div>
        <label className="block text-muted-foreground text-[11px] mb-1">
          群聊主题命名 (可选)
        </label>
        <input
          type="text"
          value={groupName}
          onChange={e => setGroupName(e.target.value)}
          placeholder="例如：天大校园事务与学习研讨小组"
          className="w-full bg-muted/20 border border-border rounded px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* Available Bot Selection Roster */}
      <div className="space-y-2">
        <label className="block text-muted-foreground text-[11px]">
          可选智能体名录 (Click to toggle):
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {PRESET_BOT_TEMPLATES.map(b => {
            const isSelected = selectedBotIds.includes(b.id);
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => toggleBot(b.id)}
                className={`p-2.5 rounded border text-left flex items-center justify-between transition-all ${
                  isSelected
                    ? 'border-primary bg-muted/50 font-bold'
                    : 'border-border bg-card hover:bg-muted/20'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-7 h-7 rounded flex items-center justify-center text-[10px] font-bold"
                    style={{ backgroundColor: b.avatarBg, color: b.avatarFg }}
                  >
                    {b.avatarSeed}
                  </div>
                  <div>
                    <span className="block text-foreground text-xs leading-tight">
                      {b.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground block font-normal">
                      {b.role}
                    </span>
                  </div>
                </div>

                <div
                  className={`w-4 h-4 rounded border flex items-center justify-center ${
                    isSelected
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-border'
                  }`}
                >
                  {isSelected && <Check size={11} strokeWidth={3} />}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-border">
        <span className="text-[10px] text-muted-foreground">
          支持 @智能体 在群聊中定向分派与交替发言
        </span>
        <div className="flex gap-2">
          {onCancel && (
            <Button variant="ghost" size="default" onClick={onCancel} className="text-xs">
              取消
            </Button>
          )}
          <Button
            variant="solid"
            size="default"
            disabled={selectedBotIds.length < 2}
            onClick={handleCreate}
            className="pixel-btn-primary text-xs font-mono"
          >
            <MessageSquare size={13} />
            创建群聊会话
          </Button>
        </div>
      </div>
    </div>
  );
}
