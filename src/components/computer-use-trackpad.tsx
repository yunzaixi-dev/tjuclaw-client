import { useRef, useState, type PointerEvent } from 'react';
import {
  Clipboard,
  Compass,
  CornerDownLeft,
  Crosshair,
  Monitor,
  MousePointer,
  Sliders,
  Terminal,
} from 'lucide-react';
import { Button } from './ui/button';
import '../retro-pixel.css';

interface ComputerUseTrackpadProps {
  vmTitle?: string;
  onPointerMove?: (x: number, y: number) => void;
  onClick?: (x: number, y: number) => void;
  onPaste?: (text: string) => void;
  onRecenter?: () => void;
}

export function ComputerUseTrackpad({
  vmTitle = 'Tencent Sandbox Chrome Headless (1920x1080)',
  onPointerMove,
  onClick,
  onPaste,
  onRecenter,
}: ComputerUseTrackpadProps) {
  const [pointerPos, setPointerPos] = useState({ x: 50, y: 50 }); // percentage
  const [isDragging, setIsDragging] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [lastActionNotice, setLastActionNotice] = useState('沙箱光标就绪');
  const [keyboardInput, setKeyboardInput] = useState('');
  const trackpadRef = useRef<HTMLDivElement>(null);

  function handlePointerDown(e: PointerEvent<HTMLDivElement>) {
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    updateCoords(e);
  }

  function handlePointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!isDragging) return;
    updateCoords(e);
  }

  function handlePointerUp(e: PointerEvent<HTMLDivElement>) {
    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    setLastActionNotice(`点击坐标: (${Math.round(pointerPos.x)}%, ${Math.round(pointerPos.y)}%)`);
    onClick?.(pointerPos.x, pointerPos.y);
  }

  function updateCoords(e: PointerEvent<HTMLDivElement>) {
    if (!trackpadRef.current) return;
    const rect = trackpadRef.current.getBoundingClientRect();
    const rawX = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const rawY = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    setPointerPos({ x: rawX, y: rawY });
    onPointerMove?.(rawX, rawY);
  }

  function handleRecenter() {
    setPointerPos({ x: 50, y: 50 });
    onRecenter?.();
    setLastActionNotice('光标已居中复位 (50%, 50%)');
    setShowMenu(false);
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        onPaste?.(text);
        setLastActionNotice(`已注入剪贴板: ${text.slice(0, 15)}...`);
      }
    } catch {
      setLastActionNotice('无法读取主机剪贴板');
    }
    setShowMenu(false);
  }

  function handleSendKeystroke() {
    if (!keyboardInput) return;
    onPaste?.(keyboardInput);
    setLastActionNotice(`已发送输入: "${keyboardInput}"`);
    setKeyboardInput('');
  }

  return (
    <div className="pixel-card p-4 space-y-4">
      {/* Top Remote Display Bar */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <Monitor size={16} className="text-primary" />
          <span className="text-xs font-mono font-bold text-foreground">
            {vmTitle}
          </span>
        </div>

        {/* Trackpad Mode Menu Trigger */}
        <div className="relative">
          <Button
            variant="floating"
            size="default"
            onClick={() => setShowMenu(!showMenu)}
            className="pixel-btn-sm font-mono text-xs flex items-center gap-1.5"
            aria-label="触控板模式菜单"
          >
            <Sliders size={12} />
            <span>触控板模式</span>
          </Button>

          {showMenu && (
            <div className="absolute right-0 top-9 w-48 bg-surface border border-border rounded-md shadow-lg p-1.5 z-30 font-mono text-xs space-y-1">
              <button
                type="button"
                onClick={handleRecenter}
                className="w-full text-left px-2.5 py-1.5 rounded hover:bg-muted flex items-center gap-2 text-foreground"
              >
                <Crosshair size={13} className="text-primary" />
                <span>居中光标 (Recenter)</span>
              </button>
              <button
                type="button"
                onClick={handlePaste}
                className="w-full text-left px-2.5 py-1.5 rounded hover:bg-muted flex items-center gap-2 text-foreground"
              >
                <Clipboard size={13} className="text-primary" />
                <span>粘贴剪贴板 (Paste)</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Simulated Remote Screen Viewport */}
      <div className="relative w-full aspect-video bg-black rounded border border-border overflow-hidden scanline-surface">
        {/* Virtual Desktop Display Canvas */}
        <div className="absolute inset-0 p-4 font-mono text-emerald-400 text-[11px] select-none flex flex-col justify-between">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-2 text-zinc-400">
            <span>[Tencent Agent Sandbox · Chrome Remote Session]</span>
            <span>1920x1080 @ 60fps</span>
          </div>

          <div className="my-auto text-center text-zinc-500">
            <p className="text-xs text-zinc-400 font-bold mb-1">
              计算机模拟操作沙箱环境 (Computer Use Surface)
            </p>
            <p className="text-[10px]">
              触摸下方深色触控区以平移、滑动与下发原生点击
            </p>
          </div>

          <div className="flex justify-between text-zinc-500 border-t border-zinc-800 pt-1 text-[10px]">
            <span>状态: {lastActionNotice}</span>
            <span>
              X: {Math.round(pointerPos.x * 19.2)}px | Y: {Math.round(pointerPos.y * 10.8)}px
            </span>
          </div>
        </div>

        {/* Dynamic Pointer Dot */}
        <div
          className="absolute w-3.5 h-3.5 pointer-events-none transition-transform duration-75"
          style={{
            left: `${pointerPos.x}%`,
            top: `${pointerPos.y}%`,
            transform: 'translate(-50%, -50%)',
          }}
        >
          <MousePointer size={14} className="text-white drop-shadow-md fill-white" />
        </div>
      </div>

      {/* Touchpad Remote Surface */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Compass size={12} />
            高敏触控板交互表面 (Touchpad Surface)
          </span>
          <span>拖拽平移 / 点击触发</span>
        </div>

        <div
          ref={trackpadRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="w-full h-36 rounded-md trackpad-surface relative cursor-crosshair flex items-center justify-center border border-border"
        >
          <div className="text-[11px] font-mono text-zinc-500 select-none pointer-events-none flex flex-col items-center gap-1">
            <Crosshair size={18} className="opacity-40" />
            <span>滑动平移光标 · 轻触点击</span>
          </div>
        </div>
      </div>

      {/* Virtual Keystroke Bar */}
      <div className="flex items-center gap-2 pt-1 font-mono text-xs">
        <Terminal size={14} className="text-muted-foreground shrink-0" />
        <input
          type="text"
          value={keyboardInput}
          onChange={e => setKeyboardInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleSendKeystroke();
          }}
          placeholder="向远程沙箱输入文本或按键 (回车发送)..."
          className="flex-1 bg-muted/30 border border-border rounded px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <Button
          variant="solid"
          size="default"
          onClick={handleSendKeystroke}
          className="pixel-btn-sm pixel-btn-primary shrink-0"
        >
          <CornerDownLeft size={12} />
          注入输入
        </Button>
      </div>
    </div>
  );
}
