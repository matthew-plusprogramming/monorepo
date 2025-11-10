'use client';

import type { JSX } from 'react';
import type { SubmitHandler, UseFormRegisterReturn } from 'react-hook-form';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/Button';

import styles from './page.module.scss';

type LoginFormValues = {
  email: string;
  password: string;
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

  const onSubmit: SubmitHandler<LoginFormValues> = async (values) => {
    // Placeholder – wire up to authentication API when available.
    console.info('Login attempt', values);
    await new Promise((resolve) => setTimeout(resolve, 400));
  };

  return (
    <form className={styles.form} noValidate onSubmit={handleSubmit(onSubmit)}>
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
        Forgot your password? Reset links are on the way once authentication is
        connected.
      </p>

      <div className={styles.actions}>
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
    </form>
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
