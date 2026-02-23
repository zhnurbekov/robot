import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('logs')
export class HttpRequestLog {
  @PrimaryGeneratedColumn({ type: 'integer' })
  id: number;

  @Column({ type: 'integer', nullable: true, name: 'lot_id' })
  lotId: number | null;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'desc' })
  desc: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  action: string | null;

  @Column({ type: 'timestamp', name: 'created_at', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ type: 'varchar', length: 256, nullable: true })
  status: string | null;
}
