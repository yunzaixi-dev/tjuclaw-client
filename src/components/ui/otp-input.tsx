import { useId, useRef, useState, type ChangeEvent, type ClipboardEvent, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';
import './otp-input.css';

export interface OtpInputProps {
  id?: string;
  name?: string;
  value: string;
  length?: number;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  hasError?: boolean;
  describedBy?: string;
  'aria-label'?: string;
  className?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
}

export function normalizeOtpDigits(raw: string): string {
  // Convert full-width ASCII digits (0xFF10-0xFF19) to standard 0-9
  return raw
    .replace(/[\uFF10-\uFF19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '');
}

export function OtpInput({
  id,
  name = 'code',
  value = '',
  length = 6,
  disabled = false,
  required = true,
  autoFocus = false,
  hasError = false,
  describedBy,
  'aria-label': ariaLabel = '邮箱验证码',
  className,
  inputRef,
  onChange,
  onComplete,
}: OtpInputProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const containerRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLInputElement>(null);
  const resolvedRef = inputRef ?? fallbackRef;
  const [focused, setFocused] = useState(false);
  const [caretPos, setCaretPos] = useState<number | null>(null);

  const digits = value.slice(0, length).split('');
  while (digits.length < length) {
    digits.push('');
  }

  const updateCaret = (input: HTMLInputElement) => {
    const selStart = input.selectionStart ?? input.value.length;
    setCaretPos(Math.min(selStart, length - 1));
  };

  const handleFocus = (event: FocusEvent<HTMLInputElement>) => {
    setFocused(true);
    updateCaret(event.target);
  };

  const handleBlur = () => {
    setFocused(false);
    setCaretPos(null);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const rawVal = event.target.value;
    const sanitized = normalizeOtpDigits(rawVal).slice(0, length);
    onChange(sanitized);
    if (sanitized.length === length && onComplete) {
      onComplete(sanitized);
    }
    updateCaret(event.target);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const pasteText = event.clipboardData.getData('text/plain');
    const digitsOnly = normalizeOtpDigits(pasteText);
    if (!digitsOnly) return;

    const input = resolvedRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;

    // Splice pasted digits into current selection
    const prefix = value.slice(0, start);
    const suffix = value.slice(end);
    const combined = normalizeOtpDigits(prefix + digitsOnly + suffix).slice(0, length);

    onChange(combined);

    const newCursor = Math.min(start + digitsOnly.length, length);
    if (input) {
      // Sync caret position after state flush
      queueMicrotask(() => {
        input.setSelectionRange(newCursor, newCursor);
        setCaretPos(Math.min(newCursor, length - 1));
      });
    }

    if (combined.length === length && onComplete) {
      onComplete(combined);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = resolvedRef.current;
    if (!input) return;

    // If user presses Delete and caret is on a digit, or Backspace
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      if (start === end) {
        if (event.key === 'Backspace' && start > 0) {
          event.preventDefault();
          const nextVal = value.slice(0, start - 1) + value.slice(start);
          onChange(nextVal);
          queueMicrotask(() => {
            input.setSelectionRange(start - 1, start - 1);
            setCaretPos(Math.min(start - 1, length - 1));
          });
        } else if (event.key === 'Delete' && start < value.length) {
          event.preventDefault();
          const nextVal = value.slice(0, start) + value.slice(start + 1);
          onChange(nextVal);
          queueMicrotask(() => {
            input.setSelectionRange(start, start);
            setCaretPos(Math.min(start, length - 1));
          });
        }
      }
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || !resolvedRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const cellWidth = rect.width / length;
    const cellIndex = Math.max(0, Math.min(Math.floor(x / cellWidth), length - 1));

    resolvedRef.current.focus();

    // Map to cell:
    // If clicking on an existing digit (cellIndex < value.length):
    // select that digit for immediate replacement typing!
    // If clicking on empty slot (cellIndex >= value.length):
    // move cursor to after the last digit (append position)
    if (cellIndex < value.length) {
      resolvedRef.current.setSelectionRange(cellIndex, cellIndex + 1);
      setCaretPos(cellIndex);
    } else {
      const targetPos = value.length;
      resolvedRef.current.setSelectionRange(targetPos, targetPos);
      setCaretPos(Math.min(targetPos, length - 1));
    }
    // Prevent default pointer behavior that would let native input steal / clear selection on mouseup
    event.preventDefault();
  };

  // Determine active index for highlight
  // When focused: active slot is either the caret position, or first empty slot
  const activeIndex = focused
    ? Math.min(caretPos ?? value.length, length - 1)
    : -1;

  return (
    <div
      ref={containerRef}
      className={cn(
        'ui-otp-container',
        hasError && 'ui-otp-container--error',
        disabled && 'ui-otp-container--disabled',
        focused && 'ui-otp-container--focused',
        className,
      )}
      onPointerDown={handlePointerDown}
    >
      <input
        ref={inputRef ?? fallbackRef}
        id={inputId}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        required={required}
        autoFocus={autoFocus}
        disabled={disabled}
        maxLength={length}
        value={value}
        aria-label={ariaLabel}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        className="ui-otp-native-input"
        onChange={handleChange}
        onPaste={handlePaste}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onKeyUp={e => updateCaret(e.currentTarget)}
        onSelect={e => updateCaret(e.currentTarget)}
      />

      <div className="ui-otp-grid" aria-hidden="true" role="presentation">
        {digits.map((digit, idx) => {
          const isFilled = digit !== '';
          const isActive = idx === activeIndex;
          return (
            <div
              key={idx}
              className={cn(
                'ui-otp-cell',
                isFilled && 'ui-otp-cell--filled',
                isActive && 'ui-otp-cell--active',
                hasError && 'ui-otp-cell--error',
              )}
            >
              <span className={cn('ui-otp-digit', isFilled && 'ui-otp-digit--populated')}>
                {digit}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
