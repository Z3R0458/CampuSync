export type Role = 'administrator' | 'guard' | 'student' | 'teacher' | 'parent'

export interface Student {
  id: string
  name: string
  grade: string
  section: string
  status: 'Present' | 'Late' | 'Absent' | 'Incomplete' | 'Early departure'
  entryTime: string
  exitTime: string
  photo: string
}

export interface Teacher {
  id: string
  name: string
  designation: string
  status: 'Present' | 'Late' | 'Absent'
  entryTime: string
  exitTime: string
}

export interface Parent {
  id: string
  name: string
  childIds: string[]
  phone: string
  email: string
}

export interface AttendanceEvent {
  id: string
  person: string
  type: 'ENTRY' | 'EXIT' | 'TEMPORARY_EXIT' | 'RETURN'
  time: string
  location: string
  device: string
  status: 'VERIFIED' | 'PENDING' | 'NEEDS_REVIEW'
}

export interface ApprovalRequest {
  id: string
  student: string
  studentId: string
  grade: string
  reason: string
  requestedAt: string
  requestedDeparture: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
}

export interface VisitorRequest {
  id: string
  visitor: string
  student: string
  relationship: string
  visitDate: string
  purpose: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
}

export interface Announcement {
  id: string
  title: string
  summary: string
  date: string
}

export interface NotificationItem {
  id: string
  title: string
  detail: string
  date: string
  unread: boolean
}

export interface DeviceStatus {
  id: string
  name: string
  online: boolean
  status: 'SYNCED' | 'PENDING' | 'FAILED'
  lastSync: string
}

export const students: Student[] = [
  {
    id: 'STU-1024',
    name: 'Juan Dela Cruz',
    grade: 'Grade 11',
    section: 'STEM-A',
    status: 'Present',
    entryTime: '7:10 AM',
    exitTime: '—',
    photo: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=300&q=80',
  },
  {
    id: 'STU-2148',
    name: 'Maria Santos',
    grade: 'Grade 10',
    section: 'GAS-B',
    status: 'Late',
    entryTime: '8:12 AM',
    exitTime: '—',
    photo: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=300&q=80',
  },
  {
    id: 'STU-3161',
    name: 'Rafael Lim',
    grade: 'Grade 9',
    section: 'HUMSS-C',
    status: 'Early departure',
    entryTime: '7:30 AM',
    exitTime: '1:20 PM',
    photo: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=300&q=80',
  },
  {
    id: 'STU-4017',
    name: 'Anya Reyes',
    grade: 'Grade 8',
    section: 'ABM-A',
    status: 'Absent',
    entryTime: '—',
    exitTime: '—',
    photo: 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&w=300&q=80',
  },
]

export const teachers: Teacher[] = [
  {
    id: 'TCH-101',
    name: 'Ms. Carmela Cruz',
    designation: 'Math Teacher',
    status: 'Present',
    entryTime: '6:50 AM',
    exitTime: '—',
  },
  {
    id: 'TCH-204',
    name: 'Mr. Ben Santos',
    designation: 'Science Teacher',
    status: 'Late',
    entryTime: '7:28 AM',
    exitTime: '—',
  },
]

export const parents: Parent[] = [
  {
    id: 'PAR-1001',
    name: 'Liza Dela Cruz',
    childIds: ['STU-1024'],
    phone: '+63 912 345 6789',
    email: 'liza@example.com',
  },
  {
    id: 'PAR-1002',
    name: 'Marta Santos',
    childIds: ['STU-2148'],
    phone: '+63 923 456 7890',
    email: 'marta@example.com',
  },
]

export const attendanceEvents: AttendanceEvent[] = [
  {
    id: 'EVT-001',
    person: 'Juan Dela Cruz',
    type: 'ENTRY',
    time: '7:10 AM',
    location: 'Gate 1',
    device: 'Guard Tablet A',
    status: 'VERIFIED',
  },
  {
    id: 'EVT-002',
    person: 'Maria Santos',
    type: 'TEMPORARY_EXIT',
    time: '11:45 AM',
    location: 'Clinic Exit',
    device: 'Guard Tablet B',
    status: 'VERIFIED',
  },
  {
    id: 'EVT-003',
    person: 'Rafael Lim',
    type: 'RETURN',
    time: '1:20 PM',
    location: 'Gate 2',
    device: 'Guard Tablet A',
    status: 'PENDING',
  },
  {
    id: 'EVT-004',
    person: 'Ms. Carmela Cruz',
    type: 'ENTRY',
    time: '6:50 AM',
    location: 'Faculty Gate',
    device: 'Teacher Scanner',
    status: 'VERIFIED',
  },
]

export const earlyOutRequests: ApprovalRequest[] = [
  {
    id: 'REQ-821',
    student: 'Rafael Lim',
    studentId: 'STU-3161',
    grade: 'Grade 9 - HUMSS-C',
    reason: 'Medical check-up',
    requestedAt: 'Today, 9:10 AM',
    requestedDeparture: '1:30 PM',
    status: 'PENDING',
  },
  {
    id: 'REQ-812',
    student: 'Anya Reyes',
    studentId: 'STU-4017',
    grade: 'Grade 8 - ABM-A',
    reason: 'Family emergency',
    requestedAt: 'Yesterday, 4:18 PM',
    requestedDeparture: '10:00 AM',
    status: 'APPROVED',
  },
]

export const visitorRequests: VisitorRequest[] = [
  {
    id: 'VIS-933',
    visitor: 'Lourdes Perez',
    student: 'Juan Dela Cruz',
    relationship: 'Mother',
    visitDate: 'Today',
    purpose: 'Submission of school requirements',
    status: 'PENDING',
  },
  {
    id: 'VIS-918',
    visitor: 'Oscar Mendoza',
    student: 'Maria Santos',
    relationship: 'Guardian',
    visitDate: 'Tomorrow',
    purpose: 'Academic consultation',
    status: 'APPROVED',
  },
]

export const announcements: Announcement[] = [
  {
    id: 'ANN-1',
    title: 'School Fair registration is now open',
    summary: 'Students may now register for the annual student fair until Friday.',
    date: 'Today',
  },
  {
    id: 'ANN-2',
    title: 'Weather advisory',
    summary: 'Classes remain on schedule. Parents are advised to prepare for light rain.',
    date: 'Yesterday',
  },
]

export const notifications: NotificationItem[] = [
  {
    id: 'NF-1',
    title: 'Entry confirmed',
    detail: 'Your child Juan Dela Cruz entered school at 7:10 AM.',
    date: 'Today, 7:12 AM',
    unread: true,
  },
  {
    id: 'NF-2',
    title: 'Early-out approval',
    detail: 'Rafael Lim’s early dismissal request was approved for 1:30 PM.',
    date: 'Today, 9:30 AM',
    unread: false,
  },
]

export const deviceStatus: DeviceStatus[] = [
  {
    id: 'DEV-01',
    name: 'Gate Tablet A',
    online: true,
    status: 'SYNCED',
    lastSync: '2 min ago',
  },
  {
    id: 'DEV-02',
    name: 'Gate Tablet B',
    online: false,
    status: 'PENDING',
    lastSync: '12 min ago',
  },
  {
    id: 'DEV-03',
    name: 'Admin Laptop',
    online: true,
    status: 'SYNCED',
    lastSync: '1 min ago',
  },
]

export const monthlyTrend = [58, 64, 71, 76, 79, 82, 88]

export const recentGateActivity = [
  { time: '7:10 AM', name: 'Juan Dela Cruz', event: 'ENTRY', result: 'VERIFIED' },
  { time: '8:12 AM', name: 'Maria Santos', event: 'LATE', result: 'VERIFIED' },
  { time: '11:45 AM', name: 'Rafael Lim', event: 'TEMPORARY_EXIT', result: 'APPROVED' },
  { time: '1:20 PM', name: 'Rafael Lim', event: 'RETURN', result: 'TRACKED' },
]

export const occupancy = {
  inside: 284,
  outside: 412,
  visitors: 12,
}

export const guardQueue = [
  { id: 'SYNC-041', student: 'Juan Dela Cruz', type: 'ENTRY', status: 'PENDING' },
  { id: 'SYNC-042', student: 'Rafael Lim', type: 'RETURN', status: 'SYNCING' },
  { id: 'SYNC-043', student: 'Maria Santos', type: 'TEMPORARY_EXIT', status: 'FAILED' },
]

export const fakeQrValue = 'schoolguard-qr-8f4ce7ee-1b6d-4a63-be7f'
