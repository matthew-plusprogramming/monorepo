import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ForwardedRef,
  forwardRef,
  type JSX,
} from 'react';

import classnames from 'classnames';

import styles from './Button.module.scss';

type DisplayStyle = 'cta' | 'secondary';
type ClickStyle = 'flat' | '3d';

type BaseProps = {
  displayStyle?: DisplayStyle;
  clickStyle?: ClickStyle;
  className?: string;
};

type ButtonAsButton = BaseProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    href?: undefined;
  };

type ButtonAsLink = BaseProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
  };

type ButtonProps = ButtonAsButton | ButtonAsLink;
type AnchorElementProps = Omit<ButtonAsLink, keyof BaseProps>;
type NativeButtonElementProps = Omit<ButtonAsButton, keyof BaseProps>;
type ButtonElementProps = AnchorElementProps | NativeButtonElementProps;

const displayClassNames: Record<DisplayStyle, string> = {
  cta: styles.displayCta,
  secondary: styles.displaySecondary,
};

const clickClassNames: Record<ClickStyle, string> = {
  flat: styles.clickFlat,
  '3d': styles.clickThreeD,
};

const isLinkProps = (props: ButtonElementProps): props is AnchorElementProps =>
  typeof props.href === 'string';

const ButtonComponent = (
  {
    displayStyle = 'cta',
    clickStyle = '3d',
    className,
    ...restProps
  }: ButtonProps,
  ref: ForwardedRef<HTMLButtonElement | HTMLAnchorElement>,
): JSX.Element => {
  const elementProps: ButtonElementProps = restProps;
  const classes = classnames(
    styles.button,
    displayClassNames[displayStyle],
    clickClassNames[clickStyle],
    className,
  );

  if (isLinkProps(elementProps)) {
    const { href, ...anchorProps } = elementProps;
    return (
      <a
        {...anchorProps}
        href={href}
        ref={ref as ForwardedRef<HTMLAnchorElement>}
        className={classes}
      />
    );
  }

  const { type = 'button', ...buttonProps } = elementProps;
  return (
    <button
      {...buttonProps}
      type={type}
      ref={ref as ForwardedRef<HTMLButtonElement>}
      className={classes}
    />
  );
};

const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  ButtonComponent,
);
Button.displayName = 'Button';

export { Button };
export type { ButtonProps };
