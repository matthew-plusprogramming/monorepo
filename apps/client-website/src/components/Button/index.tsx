import {
  type ButtonHTMLAttributes,
  type ForwardedRef,
  forwardRef,
  type JSX,
} from 'react';

import classnames from 'classnames';

import styles from './Button.module.scss';

type DisplayStyle = 'cta' | 'secondary';
type ClickStyle = 'flat' | '3d';

type ButtonProps = {
  displayStyle?: DisplayStyle;
  clickStyle?: ClickStyle;
} & ButtonHTMLAttributes<HTMLButtonElement>;

const displayClassNames: Record<DisplayStyle, string> = {
  cta: styles.displayCta,
  secondary: styles.displaySecondary,
};

const clickClassNames: Record<ClickStyle, string> = {
  flat: styles.clickFlat,
  '3d': styles.clickThreeD,
};

const ButtonComponent = (
  {
    displayStyle = 'cta',
    clickStyle = '3d',
    type = 'button',
    className,
    ...props
  }: ButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
): JSX.Element => {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classnames(
        styles.button,
        displayClassNames[displayStyle],
        clickClassNames[clickStyle],
        className,
      )}
    />
  );
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(ButtonComponent);
Button.displayName = 'Button';

export { Button };
export type { ButtonProps };
