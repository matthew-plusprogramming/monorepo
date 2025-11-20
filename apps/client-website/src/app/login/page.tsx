'use client';

import { type JSX, useEffect, useState } from 'react';

import { useRouter } from 'next/navigation';
import type { SubmitHandler, UseFormRegisterReturn } from 'react-hook-form';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/Button';
import { Toast } from '@/components/Toast';
import { useLoginMutation } from '@/hooks/useLoginMutation';
import { useUserStore } from '@/stores/userStore';

import styles from './page.module.scss';

type LoginFormValues = {
  email: string;
  password: string;
};

type LoginFlowResult = {
  dismissToast: () => void;
  handleLogin: SubmitHandler<LoginFormValues>;
  loginMutation: ReturnType<typeof useLoginMutation>;
  toastMessage: string | null;
};

type FieldProps = {
  id: keyof LoginFormValues;
  label: string;
  placeholder: string;
  type: 'email' | 'password';
  registration: UseFormRegisterReturn;
  error?: string;
};

const emailPattern =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const FormField = ({
  id,
  label,
  placeholder,
  type,
  registration,
  error,
}: FieldProps): JSX.Element => {
  const errorId = `${id}-error`;
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <input
        {...registration}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={error ? errorId : undefined}
        className={styles.input}
        id={id}
        placeholder={placeholder}
        type={type}
      />
      {error && (
        <span
          className={styles.error}
          id={errorId}
          role="alert"
          aria-live="polite"
        >
          {error}
        </span>
      )}
    </div>
  );
};

type FormActionsProps = {
  isSubmitting: boolean;
  errorMessage?: string;
};

const FormActions = ({
  isSubmitting,
  errorMessage,
}: FormActionsProps): JSX.Element => {
  return (
    <div className={styles.actions}>
      {errorMessage && (
        <p className={styles.formError} role="alert" aria-live="polite">
          {errorMessage}
        </p>
      )}
      <Button
        className={styles.submitButton}
        disabled={isSubmitting}
        displayStyle="cta"
        clickStyle="3d"
        type="submit"
      >
        {isSubmitting ? 'Signing you in…' : 'Sign in'}
      </Button>
    </div>
  );
};

const useLoginFlow = (): LoginFlowResult => {
  const router = useRouter();
  const setToken = useUserStore((state) => state.setToken);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [shouldRedirect, setShouldRedirect] = useState(false);
  const loginMutation = useLoginMutation();

  useEffect(() => {
    if (!shouldRedirect) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      router.push('/');
    }, 900);

    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [router, shouldRedirect]);

  const handleLogin: SubmitHandler<LoginFormValues> = async (values) => {
    setShouldRedirect(false);
    setToastMessage(null);

    try {
      const token = await loginMutation.mutateAsync({
        identifier: values.email,
        password: values.password,
      });

      setToken(token);
      setToastMessage('Signed in. Redirecting you home.');
      setShouldRedirect(true);
    } catch {
      setToastMessage(null);
      setShouldRedirect(false);
    }
  };

  const dismissToast = (): void => {
    setToastMessage(null);
    setShouldRedirect(false);
  };

  return { dismissToast, handleLogin, loginMutation, toastMessage };
};

const LoginForm = (): JSX.Element => {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const { dismissToast, handleLogin, loginMutation, toastMessage } =
    useLoginFlow();

  const isBusy = isSubmitting || loginMutation.isPending;

  return (
    <>
      <form
        className={styles.form}
        noValidate
        onSubmit={handleSubmit(handleLogin)}
      >
        <FormField
          error={errors.email?.message}
          id="email"
          label="Email address"
          placeholder="you@domain.com"
          registration={register('email', {
            required: 'Email is required',
            pattern: {
              value: emailPattern,
              message: 'Enter a valid email address',
            },
          })}
          type="email"
        />

        <FormField
          error={errors.password?.message}
          id="password"
          label="Password"
          placeholder="••••••••"
          registration={register('password', {
            required: 'Password is required',
            minLength: {
              value: 8,
              message: 'Use at least 8 characters',
            },
          })}
          type="password"
        />

        <p className={styles.supportText}>
          Forgot your password? Reset links are on the way once authentication
          is connected.
        </p>

        <FormActions
          errorMessage={loginMutation.error?.message}
          isSubmitting={isBusy}
        />
      </form>

      {toastMessage ? (
        <Toast message={toastMessage} onDismiss={dismissToast} />
      ) : null}
    </>
  );
};

const LoginPage = (): JSX.Element => {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1>Welcome back</h1>
          <p>Sign in to continue building your next idea.</p>
        </div>

        <LoginForm />

        <a className={styles.utilityLink} href="/signup">
          Need an account? Start building
        </a>
      </div>
    </div>
  );
};

export default LoginPage;
