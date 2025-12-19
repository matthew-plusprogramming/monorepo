'use client';
import { type JSX } from 'react';

import { Button, Toast } from '@ui/components';
import Link from 'next/link';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { useForm } from 'react-hook-form';

import {
  buildFieldConfigs,
  type SignupFormValues,
  useSignupFlow,
} from './hooks';

import styles from './page.module.scss';

type FieldProps = {
  id: keyof SignupFormValues;
  label: string;
  placeholder: string;
  type: 'text' | 'email' | 'password';
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
const SignupForm = (): JSX.Element => {
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormValues>({
    defaultValues: {
      fullName: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  });

  const {
    dismissToast,
    formError,
    handleSignup,
    registerMutation,
    toastMessage,
  } = useSignupFlow();

  const fieldConfigs = buildFieldConfigs(getValues);
  const isBusy = isSubmitting || registerMutation.isPending;

  return (
    <>
      <form
        className={styles.form}
        noValidate
        onSubmit={handleSubmit(handleSignup)}
      >
        {fieldConfigs.map(({ id, label, placeholder, type, rules }) => (
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
          By creating an account, you agree to share basic profile information
          once onboarding is connected.
        </p>

        <div className={styles.actions}>
          {formError ? (
            <p className={styles.formError} role="alert" aria-live="polite">
              {formError}
            </p>
          ) : null}
          <Button
            className={styles.submitButton}
            disabled={isBusy}
            displayStyle="cta"
            clickStyle="3d"
            type="submit"
          >
            {isBusy ? 'Creating account…' : 'Create account'}
          </Button>
        </div>
      </form>

      {toastMessage ? (
        <Toast message={toastMessage} onDismiss={dismissToast} />
      ) : null}
    </>
  );
};
const SignupPage = (): JSX.Element => {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1>Create your account</h1>
          <p>Spin up new projects faster with a collaborative workspace.</p>
        </div>

        <SignupForm />

        <Link className={styles.utilityLink} href="/login">
          Already have an account? Sign in
        </Link>
      </div>
    </div>
  );
};

export default SignupPage;
