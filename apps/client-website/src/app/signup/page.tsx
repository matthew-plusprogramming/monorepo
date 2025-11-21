'use client';
import { type JSX, useEffect, useState } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  RegisterOptions,
  SubmitHandler,
  UseFormGetValues,
  UseFormRegisterReturn,
} from 'react-hook-form';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/Button';
import { Toast } from '@/components/Toast';
import { useRegisterMutation } from '@/hooks/useRegisterMutation';

import styles from './page.module.scss';

type SignupFormValues = {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
};

type FieldProps = {
  id: keyof SignupFormValues;
  label: string;
  placeholder: string;
  type: 'text' | 'email' | 'password';
  registration: UseFormRegisterReturn;
  error?: string;
};

type SignupFieldConfig = Omit<FieldProps, 'registration' | 'error'> & {
  rules: RegisterOptions<SignupFormValues, keyof SignupFormValues>;
};
const emailPattern =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const baseFieldConfigs: SignupFieldConfig[] = [
  {
    id: 'fullName',
    label: 'Full name',
    placeholder: 'Ada Lovelace',
    type: 'text',
    rules: {
      required: 'Name is required',
      minLength: {
        value: 2,
        message: 'Use at least 2 characters',
      },
    },
  },
  {
    id: 'email',
    label: 'Email address',
    placeholder: 'you@domain.com',
    type: 'email',
    rules: {
      required: 'Email is required',
      pattern: {
        value: emailPattern,
        message: 'Enter a valid email address',
      },
    },
  },
  {
    id: 'password',
    label: 'Password',
    placeholder: '••••••••',
    type: 'password',
    rules: {
      required: 'Password is required',
      minLength: {
        value: 8,
        message: 'Use at least 8 characters',
      },
    },
  },
];
const buildFieldConfigs = (
  getValues: UseFormGetValues<SignupFormValues>,
): SignupFieldConfig[] => [
  ...baseFieldConfigs,
  {
    id: 'confirmPassword',
    label: 'Confirm password',
    placeholder: '••••••••',
    type: 'password',
    rules: {
      required: 'Please confirm your password',
      validate: (value) =>
        value === getValues('password') || 'Passwords must match',
    },
  },
];
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
type SignupFlowResult = {
  dismissToast: () => void;
  formError: string | null;
  handleSignup: SubmitHandler<SignupFormValues>;
  registerMutation: ReturnType<typeof useRegisterMutation>;
  toastMessage: string | null;
};

const useSignupFlow = (): SignupFlowResult => {
  const router = useRouter();
  const registerMutation = useRegisterMutation();
  const [formError, setFormError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [shouldRedirect, setShouldRedirect] = useState(false);

  useEffect(() => {
    if (!shouldRedirect) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      router.push('/login');
    }, 900);

    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [router, shouldRedirect]);

  const handleSignup: SubmitHandler<SignupFormValues> = async (values) => {
    setToastMessage(null);
    setFormError(null);
    setShouldRedirect(false);

    try {
      await registerMutation.mutateAsync({
        username: values.fullName,
        email: values.email,
        password: values.password,
      });

      setToastMessage('Account created. Redirecting you to sign in.');
      setShouldRedirect(true);
    } catch (error) {
      setToastMessage(null);
      setShouldRedirect(false);
      setFormError(
        error instanceof Error
          ? error.message
          : 'Unable to create your account right now.',
      );
    }
  };

  const dismissToast = (): void => {
    setToastMessage(null);
    setShouldRedirect(false);
  };

  return {
    dismissToast,
    formError,
    handleSignup,
    registerMutation,
    toastMessage,
  };
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
