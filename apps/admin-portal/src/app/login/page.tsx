'use client';

import { type JSX } from 'react';

import { Button, Toast } from '@ui/components';
import Link from 'next/link';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { useForm } from 'react-hook-form';

import { loginFieldConfigs, type LoginFormValues, useLoginFlow } from './hooks';

import styles from './page.module.scss';

type FieldProps = {
  id: keyof LoginFormValues;
  label: string;
  placeholder: string;
  type: 'email' | 'password';
  registration: UseFormRegisterReturn;
  error?: string;
};

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
        {loginFieldConfigs.map(({ id, label, placeholder, type, rules }) => (
          <FormField
            key={id}
            error={errors[id]?.message}
            id={id}
            label={label}
            placeholder={placeholder}
            registration={register(id, rules)}
            type={type}
          />
        ))}

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

        <Link className={styles.utilityLink} href="/signup">
          Need an account? Start building
        </Link>
      </div>
    </div>
  );
};

export default LoginPage;
