'use client';

import { useState } from 'react';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type {
  RegisterOptions,
  SubmitHandler,
  UseFormGetValues,
} from 'react-hook-form';

import {
  register as registerUser,
  type RegisterPayload,
} from '@/lib/api/register';
import { useUserStore } from '@/stores/userStore';

export type SignupFormValues = {
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
};

export type SignupFieldConfig = {
  id: keyof SignupFormValues;
  label: string;
  placeholder: string;
  type: 'text' | 'email' | 'password';
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

export const buildFieldConfigs = (
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

export const useRegisterMutation = (): UseMutationResult<
  string,
  Error,
  RegisterPayload
> => {
  return useMutation<string, Error, RegisterPayload>({
    mutationFn: registerUser,
  });
};

type UseRegisterMutationHook = () => ReturnType<typeof useRegisterMutation>;

export type SignupFlowResult = {
  dismissToast: () => void;
  formError: string | null;
  handleSignup: SubmitHandler<SignupFormValues>;
  registerMutation: ReturnType<typeof useRegisterMutation>;
  toastMessage: string | null;
};

export const useSignupFlow = (
  useRegisterMutationHook: UseRegisterMutationHook = useRegisterMutation,
): SignupFlowResult => {
  const router = useRouter();
  const registerMutation = useRegisterMutationHook();
  const setToken = useUserStore((state) => state.setToken);
  const [formError, setFormError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const handleSignup: SubmitHandler<SignupFormValues> = async (values) => {
    setToastMessage(null);
    setFormError(null);

    try {
      const token = await registerMutation.mutateAsync({
        fullName: values.fullName,
        username: values.fullName,
        email: values.email,
        password: values.password,
      });

      setToken(token);
      setToastMessage('Account created. Redirecting you home.');
      router.push('/home');
    } catch (error) {
      setToastMessage(null);
      setFormError(
        error instanceof Error
          ? error.message
          : 'Unable to create your account right now.',
      );
    }
  };

  const dismissToast = (): void => {
    setToastMessage(null);
  };

  return {
    dismissToast,
    formError,
    handleSignup,
    registerMutation,
    toastMessage,
  };
};
