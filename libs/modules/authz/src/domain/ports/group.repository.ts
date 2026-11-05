import type { DbExecutor } from '@platform';
import type { Permission, GroupWithPermissions } from '@platform';

export const GROUP_REPOSITORY = Symbol('GROUP_REPOSITORY');

export interface CreateGroupInput {
  key: string;
  name: string;
  permissions: string[];
}

export interface IGroupRepository {
  list(): Promise<GroupWithPermissions[]>;
  findById(id: string): Promise<GroupWithPermissions | null>;
  findByKey(key: string): Promise<GroupWithPermissions | null>;
  create(input: CreateGroupInput, tx?: DbExecutor): Promise<GroupWithPermissions>;
  /** Replace a group's permission set atomically. */
  setPermissions(groupId: string, permissionKeys: string[], tx?: DbExecutor): Promise<void>;
  delete(groupId: string, tx?: DbExecutor): Promise<void>;
  /** Full permission catalog. */
  listPermissions(): Promise<Permission[]>;
}
