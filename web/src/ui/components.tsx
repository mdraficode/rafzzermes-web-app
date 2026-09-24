import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { AlertIcon, CloseIcon } from './icons';

export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size, borderWidth: Math.max(2, size / 9) }}
      role={label ? 'status' : undefined}
      aria-label={label}
    />
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  trailing?: ReactNode;
  hint?: string;
  errorText?: string;
}

/** Material-style outlined field: label above, focus ring, optional trailing slot. */
export function TextField({
  label,
  value,
  onValueChange,
  trailing,
  hint,
  errorText,
  id,
  ...rest
}: TextFieldProps) {
  const inputId = id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const describedBy = hint || errorText ? `${inputId}-desc` : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className={`field-control${errorText ? ' field-control-error' : ''}`}>
        <input
          id={inputId}
          className="field-input"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          aria-describedby={describedBy}
          aria-invalid={errorText ? true : undefined}
          {...rest}
        />
        {trailing ? <div className="field-trailing">{trailing}</div> : null}
      </div>
      {errorText ? (
        <p className="field-desc field-desc-error" id={describedBy}>
          {errorText}
        </p>
      ) : hint ? (
        <p className="field-desc" id={describedBy}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface PrimaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  fullWidth?: boolean;
}

export function PrimaryButton({
  children,
  loading = false,
  fullWidth = false,
  disabled,
  className,
  ...rest
}: PrimaryButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn-primary${fullWidth ? ' btn-block' : ''}${className ? ` ${className}` : ''}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={18} /> : null}
      <span>{children}</span>
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: these buttons are icon-only, so the label is the accessible name. */
  label: string;
  variant?: 'ghost' | 'solid';
}

export function IconButton({
  label,
  variant = 'ghost',
  children,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn icon-btn-${variant}${className ? ` ${className}` : ''}`}
      title={label}
      aria-label={label}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface BannerProps {
  tone?: 'error' | 'warning' | 'info' | 'success';
  title?: string;
  children: ReactNode;
  onDismiss?: () => void;
  actions?: ReactNode;
}

export function Banner({ tone = 'info', title, children, onDismiss, actions }: BannerProps) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="banner-icon">
        <AlertIcon />
      </span>
      <div className="banner-body">
        {title ? <p className="banner-title">{title}</p> : null}
        <div className="banner-text">{children}</div>
        {actions ? <div className="banner-actions">{actions}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton label="Dismiss" onClick={onDismiss} className="banner-close">
          <CloseIcon width={16} height={16} />
        </IconButton>
      ) : null}
    </div>
  );
}
